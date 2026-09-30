'use strict';

// Agent sessions (#2779) against a real PostgreSQL: the trigger that stamps
// every transcript row with its conversation, the foreign keys that decide
// what outlives what, and the data layer's statements.
//
// A mock cannot have a trigger, and the whole point of this one is that the
// dozens of places that insert a message row never have to know agent
// sessions exist. So the migration is lifted VERBATIM out of schema.sql and
// run over the handful of columns it touches, the way
// tests/pr-vote-epoch-postgres.test.js does. Set TEST_DATABASE_URL to point
// it somewhere; without one it skips.
//
// Run with: node --test tests/agent-sessions-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const agentSessions = require('../src/services/agent-sessions');
const actions = require('../src/services/agent-session-actions');
const mcpOauth = require('../src/services/mcp-oauth');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const CONFIG = { dataEncryptionKey: crypto.randomBytes(32).toString('hex') };

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// The block as shipped: from its banner to the confirmation cards' table
// (step 3b), which follows the delegation foreign key.
function agentSessionsMigration() {
  const start = SCHEMA.indexOf('-- Agent sessions (#2779, spec: docs/agent-sessions.md)');
  assert.ok(start > 0, 'the agent-sessions block must be findable in schema.sql');
  const marker = "COMMENT ON TABLE agent_session_actions IS 'staging:private';";
  const end = SCHEMA.indexOf(marker, start);
  assert.ok(end > start, 'and its end');
  // And the block that keeps every screen of a conversation in step (the
  // version, the message revs, the triggers that bump and announce them),
  // which follows the drafts and attachments blocks.
  const syncStart = SCHEMA.indexOf('-- ── Keeping every screen of a conversation in step with the server');
  const syncMarker = 'EXECUTE FUNCTION agent_session_state_announce();\n  END IF;\nEND $$;';
  const syncEnd = SCHEMA.indexOf(syncMarker, syncStart);
  assert.ok(syncStart > end && syncEnd > syncStart, 'the sync block must be findable in schema.sql');
  return `${SCHEMA.slice(start, end + marker.length)}\n${SCHEMA.slice(syncStart, syncEnd + syncMarker.length)}`;
}

async function connect(t, { beforeMigration = null } = {}) {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
    return null;
  }
  await client.query('DROP SCHEMA IF EXISTS agent_sessions_test CASCADE');
  await client.query('CREATE SCHEMA agent_sessions_test');
  await client.query('SET search_path = agent_sessions_test');
  // Only the columns the migration and the data layer touch.
  await client.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE apps (
      id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, created_by INTEGER,
      self_hosted BOOLEAN DEFAULT FALSE,
      -- The two icon columns the data layer's focus-app projection now reads
      -- (the "Open app" header button draws the app's own artwork from them).
      -- The real table gets them from ALTER TABLE later in schema.sql; this
      -- reduced copy creates them up front, the way it creates every other
      -- column the agent-sessions statements touch.
      icon_emoji VARCHAR(32), icon_image_id VARCHAR(32),
      moderation_suspended_at TIMESTAMPTZ,
      collab_visibility TEXT NOT NULL DEFAULT 'public', view_visibility TEXT NOT NULL DEFAULT 'public');
    CREATE TABLE user_app_blocks (user_id INTEGER, app_id INTEGER, PRIMARY KEY (user_id, app_id));
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), user_id INTEGER REFERENCES users(id),
      status VARCHAR(32) NOT NULL DEFAULT 'active', source TEXT,
      pr_number INTEGER, pr_title VARCHAR(256), session_title TEXT,
      staging_url TEXT, check_state VARCHAR(32), test_results JSONB NOT NULL DEFAULT '[]',
      -- Why a skipped run was skipped (activeChange.checkSkipReason, #3180).
      check_error_detail TEXT,
      shots_state VARCHAR(24), shots_run_id VARCHAR(32),
      -- A change's own durable turn (a build restart recovery can adopt).
      active_turn JSONB);
    -- The active change's running preview (activeChange.previewCapture).
    CREATE TABLE shot_runs (
      id VARCHAR(32) PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ);
    CREATE TABLE chat_session_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL, content TEXT NOT NULL, model VARCHAR(100),
      cost_cents NUMERIC(10,4) DEFAULT 0, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      -- The dev chat's delivery id (#3177), which a conversation's sends
      -- carry too; the real table gets it from an ALTER earlier in schema.sql.
      client_message_id VARCHAR(64));
    CREATE TABLE mcp_delegations (grant_id TEXT PRIMARY KEY, agent_session_id INTEGER);
    INSERT INTO users (id, username) VALUES (7, 'ada'), (8, 'bo');
    INSERT INTO apps (id, slug, name) VALUES (3, 'recipe-box', 'Recipe box');
  `);
  if (beforeMigration) await beforeMigration(client);
  await client.query(agentSessionsMigration());
  return client;
}

async function done(client, pool = null) {
  if (pool) await pool.end().catch(() => {});
  await client.query('DROP SCHEMA IF EXISTS agent_sessions_test CASCADE').catch(() => {});
  await client.end();
}

// A pool on the test schema, for statements that must really run on separate
// connections at once (the claim a card's Confirm makes) or that check a
// client out themselves (the delegation sweeper).
function schemaPool() {
  return new Pool({ connectionString: DATABASE_URL, options: '-c search_path=agent_sessions_test', max: 6 });
}

// A stand-in for the MCP shim: what a confirmed action would have run.
function fakeShim(calls, result = { isError: false, structured: { message: 'Filed request #12.' }, text: '' }) {
  return async (args) => ({
    call: async (name, input) => {
      calls.push({ name, input, args });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    },
    close: async () => {},
  });
}

test('a grant written before the table existed cannot stop the schema applying', async (t) => {
  // The one thing a schema block must never do is fail at boot. A delegation
  // that names an agent session id from before agent_sessions existed has to
  // leave the foreign key addable.
  const client = await connect(t, { beforeMigration: async (c) => {
    await c.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('orphan', 999)");
  } });
  if (!client) return;
  try {
    const { rows } = await client.query(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'mcp_delegations_agent_session_fk'"
    );
    assert.equal(rows.length, 1, 'the key exists');
    await assert.rejects(
      client.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('new', 998)"),
      /mcp_delegations_agent_session_fk/, 'and binds every row written after it'
    );
  } finally {
    await done(client);
  }
});

test('the migration is idempotent', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    await client.query(agentSessionsMigration());
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgname = 'chat_session_messages_stamp_agent_session' AND NOT tgisinternal`
    );
    assert.equal(rows[0].n, 1, 'one trigger after two runs');
    const { rows: comment } = await client.query("SELECT obj_description('agent_sessions'::regclass) AS c");
    assert.equal(comment[0].c, 'staging:private');
  } finally {
    await done(client);
  }
});

test('every row a change writes lands in its conversation, whoever inserts it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, {
      user: { id: 7 }, hint: { slug: 'recipe-box', entry: 'improve' },
    });
    assert.equal(session.focusApp.slug, 'recipe-box');
    const { rows: [child] } = await client.query(
      "INSERT INTO chat_sessions (app_id, user_id, session_title) VALUES (3, 7, 'Dark mode') RETURNING *"
    );
    const { rows: [classic] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING *'
    );
    // A row the change wrote before it was linked is backfilled by the link.
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', 'early')", [child.id]
    );
    assert.equal(await agentSessions.linkChange(client, {
      agentSessionId: session.id, userId: 7, change: { ...child, app_name: 'Recipe box' },
    }), true);

    // The shape of every existing insert site: it names the change and
    // nothing else.
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'built it')", [child.id]
    );
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'classic')", [classic.id]
    );

    const { rows } = await client.query(
      'SELECT content, session_id, agent_session_id FROM chat_session_messages ORDER BY id'
    );
    assert.deepEqual(rows.map((r) => [r.content, r.agent_session_id]), [
      ['early', session.id],
      ['Started a change on Recipe box: Dark mode', session.id],
      ['built it', session.id],
      ['classic', null],
    ]);

    const conversation = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.deepEqual(conversation.messages.map((m) => [m.content, m.changeId]), [
      ['early', child.id],
      ['Started a change on Recipe box: Dark mode', null],
      ['built it', child.id],
    ]);
    assert.equal(await agentSessions.listMessages(client, { userId: 8, id: session.id }), null,
      'another user reads nothing');

    const detail = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(detail.activeChange.id, child.id);
    assert.equal(detail.activeChange.title, 'Dark mode');
    assert.deepEqual(detail.changes.map((c) => c.id), [child.id]);
    assert.equal(detail.activeChange.checkSkipReason, null, 'no verdict, no reason');

    // #3180: a skipped run carries why; any other verdict's detail stays out.
    await client.query(
      "UPDATE chat_sessions SET check_state = 'skipped', check_error_detail = 'nothing to test' WHERE id = $1", [child.id]
    );
    const skipped = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(skipped.activeChange.checkSkipReason, 'nothing to test');
    assert.equal(skipped.changes[0].checkSkipReason, 'nothing to test');
    assert.equal((await agentSessions.listAgentSessions(client, { userId: 7 })).sessions
      .find((s) => s.id === session.id).activeChange.checkSkipReason, 'nothing to test');
    await client.query("UPDATE chat_sessions SET check_state = 'error' WHERE id = $1", [child.id]);
    const errored = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(errored.activeChange.checkSkipReason, null);

    // An explicit conversation id is never overwritten by the trigger.
    const other = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await client.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content)
       VALUES ($1, $2, 'system', 'explicit')`, [child.id, other.id]
    );
    const { rows: explicit } = await client.query(
      "SELECT agent_session_id FROM chat_session_messages WHERE content = 'explicit'"
    );
    assert.equal(explicit[0].agent_session_id, other.id);
  } finally {
    await done(client);
  }
});

test('a closed change clears the active change and leaves a note', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const { rows: [child] } = await client.query(
      "INSERT INTO chat_sessions (app_id, user_id, pr_number) VALUES (3, 7, 901) RETURNING *"
    );
    await agentSessions.linkChange(client, { agentSessionId: session.id, userId: 7, change: child });
    const { rows: [row] } = await client.query('SELECT * FROM chat_sessions WHERE id = $1', [child.id]);
    assert.equal(await agentSessions.noteChangeClosed(client, { change: row, outcome: 'merged' }), true);
    const detail = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(detail.activeChange, null);
    const { messages } = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.equal(messages.at(-1).content, 'PR #901 merged. It is part of the app now.');
    assert.equal(messages.at(-1).metadata.agentSessionEvent, 'change_closed');
  } finally {
    await done(client);
  }
});

test('what outlives a deleted conversation, and what does not', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const { rows: [child] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING *'
    );
    await agentSessions.linkChange(client, { agentSessionId: session.id, userId: 7, change: child });
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'kept')", [child.id]
    );
    await client.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('g', $1)", [session.id]);

    // What account deletion runs, lifted from the service, then the user.
    const deletion = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'account-deletion.js'), 'utf8');
    const statement = deletion.match(/`(DELETE FROM chat_session_messages WHERE session_id IS NULL[\s\S]*?)`/)[1];
    await client.query(statement, [7]);
    await client.query('DELETE FROM agent_sessions WHERE user_id = 7');

    const { rows: left } = await client.query('SELECT content, agent_session_id FROM chat_session_messages ORDER BY id');
    assert.deepEqual(left.map((r) => [r.content, r.agent_session_id]), [['kept', null]],
      'the change\'s own row survives; the conversation note does not');
    const { rows: changes } = await client.query('SELECT agent_session_id FROM chat_sessions');
    assert.deepEqual(changes.map((r) => r.agent_session_id), [null], 'the change outlives its parent');
    const { rows: grants } = await client.query('SELECT * FROM mcp_delegations');
    assert.equal(grants.length, 0, 'a grant goes with the session it served');
  } finally {
    await done(client);
  }
});

test('the constraints hold', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, status) VALUES (7, 'closed')"));
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, status) VALUES (7, 'archived')"),
      'archived needs archived_at');
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, focus_context) VALUES (7, '[]')"));
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const archived = await agentSessions.archiveAgentSession(client, { userId: 7, id: session.id });
    assert.equal(archived.status, 'archived');
    const reopened = await agentSessions.unarchiveAgentSession(client, { userId: 7, id: session.id });
    assert.equal(reopened.status, 'open');
    await assert.rejects(
      agentSessions.prepareChangeStart(client, { agentSessionId: session.id, userId: 8 }),
      /not found/, 'another user cannot start a change in it'
    );
  } finally {
    await done(client);
  }
});

test('a card runs once, however many Confirm presses race for it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const input = { slug: 'recipe-box', title: 'Dark mode', body: 'Please.' };
    const card = await actions.prepareAction(client, {
      config: CONFIG, userId: 7, agentSessionId: session.id, toolName: 'create_request', input,
    });
    const { rows: [stored] } = await client.query('SELECT * FROM agent_session_actions WHERE id = $1', [card.id]);
    assert.equal(stored.status, 'pending');
    assert.ok(!JSON.stringify(stored.sealed_input).includes('Dark mode'), 'the input is stored sealed');

    const calls = [];
    const presses = await Promise.allSettled(Array.from({ length: 5 }, () => actions.confirmAction(pool, {
      config: CONFIG, user: { id: 7 }, agentSessionId: session.id, actionId: card.id,
      deps: { openMayorMcp: fakeShim(calls) },
    })));
    assert.equal(calls.length, 1, 'the tool ran once');
    assert.deepEqual(calls[0].input, input, 'with exactly the input the card showed');
    assert.equal(calls[0].args.appId, 3, 'on a grant bound to the app it names');
    assert.equal(calls[0].args.changeId, null);
    assert.equal(presses.filter((p) => p.status === 'fulfilled').length, 1);
    for (const refused of presses.filter((p) => p.status === 'rejected')) {
      assert.equal(refused.reason.code, 'action_used');
    }

    const { rows: [after] } = await client.query('SELECT status, result, decided_at FROM agent_session_actions WHERE id = $1', [card.id]);
    assert.equal(after.status, 'done');
    assert.equal(after.result.ok, true);
    assert.ok(after.decided_at);
    const { messages } = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.equal(messages.at(-1).content, 'Confirmed: File a request. Filed request #12.');
    assert.equal(messages.at(-1).metadata.agentSessionEvent, 'action_result');
  } finally {
    await done(client, pool);
  }
});

test('an expired, dismissed, foreign or archived card is refused, and the listing says which', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const prepare = (overrides = {}) => actions.prepareAction(client, {
      config: CONFIG, userId: 7, agentSessionId: session.id, toolName: 'claim_request',
      input: { slug: 'recipe-box', number: 4 }, ...overrides,
    });
    const confirm = (actionId, user = { id: 7 }) => actions.confirmAction(client, {
      config: CONFIG, user, agentSessionId: session.id, actionId,
      deps: { openMayorMcp: async () => { throw new Error('must not open a grant'); } },
    });

    const stale = await prepare({ now: new Date(Date.now() - actions.ACTION_TTL_MS - 60_000) });
    await assert.rejects(confirm(stale.id), (err) => err.status === 410 && err.code === 'action_expired');

    const dismissed = await prepare();
    assert.equal(await actions.dismissAction(client, { user: { id: 7 }, agentSessionId: session.id, actionId: dismissed.id }), true);
    assert.equal(await actions.dismissAction(client, { user: { id: 7 }, agentSessionId: session.id, actionId: dismissed.id }), false,
      'a card is dismissed once');
    await assert.rejects(confirm(dismissed.id), (err) => err.status === 409 && err.code === 'action_used');

    const fresh = await prepare();
    await assert.rejects(confirm(fresh.id, { id: 8 }), (err) => err.status === 404, 'another user cannot see it');
    assert.equal(await actions.dismissAction(client, { user: { id: 8 }, agentSessionId: session.id, actionId: fresh.id }), false);
    assert.deepEqual(await actions.listActions(client, { userId: 8, agentSessionId: session.id }), []);

    await agentSessions.archiveAgentSession(client, { userId: 7, id: session.id });
    await assert.rejects(confirm(fresh.id), (err) => err.status === 409 && err.code === 'session_archived');
    await assert.rejects(prepare(), (err) => err.status === 404, 'an archived conversation takes no new cards');

    const listed = await actions.listActions(client, { userId: 7, agentSessionId: session.id });
    assert.deepEqual(listed.map((a) => a.status).sort(), ['dismissed', 'expired', 'pending']);
    assert.ok(listed.every((a) => !('sealedInput' in a) && !('input' in a)), 'the listing never carries the input');
    const { messages } = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.equal(messages.at(-1).content, 'Dismissed: Claim the request. Nothing was changed.');

    await assert.rejects(client.query(
      `INSERT INTO agent_session_actions (id, agent_session_id, user_id, tool_name, sealed_input, input_hash, status, expires_at)
       VALUES (gen_random_uuid(), $1, 7, 'claim_request', '{}', $2, 'confirmed', NOW() + interval '1 minute')`,
      [session.id, 'a'.repeat(64)]
    ), /agent_session_actions_status_check/);
    await assert.rejects(client.query(
      `INSERT INTO agent_session_actions (id, agent_session_id, user_id, tool_name, sealed_input, input_hash, expires_at)
       VALUES (gen_random_uuid(), $1, 7, 'claim_request', '{}', 'not-a-hash', NOW() + interval '1 minute')`,
      [session.id]
    ), /agent_session_actions_hash_check/);
  } finally {
    await done(client);
  }
});

test('one Mayor turn at a time, and a dead turn\'s lease is taken over', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const acquire = (turnId, userId = 7) => agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId, turnId });
    const release = (turnId) => agentSessions.releaseTurnLease(client, { agentSessionId: session.id, turnId });

    assert.equal(await acquire('turn-a'), true);
    assert.equal(await acquire('turn-b'), false, 'a second turn waits');
    assert.equal(await acquire('turn-c', 8), false, 'another user never takes it');
    await release('turn-b');
    assert.equal(await acquire('turn-b'), false, 'only the turn holding the lease releases it');
    await release('turn-a');
    assert.equal(await acquire('turn-b'), true);

    await client.query(
      `UPDATE agent_sessions
          SET active_turn = jsonb_build_object('id', 'turn-b', 'startedAt', NOW() - make_interval(secs => $2))
        WHERE id = $1`,
      [session.id, agentSessions.TURN_LEASE_STALE_SECONDS + 30]
    );
    // A turn that is still running renews its lease; only the holder can.
    assert.equal(await agentSessions.renewTurnLease(client, { agentSessionId: session.id, turnId: 'turn-x' }), false);
    assert.equal(await agentSessions.renewTurnLease(client, { agentSessionId: session.id, turnId: 'turn-b' }), true);
    assert.equal(await acquire('turn-d'), false, 'a renewed lease is live however long ago it started');
    await client.query(
      `UPDATE agent_sessions
          SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW() - make_interval(secs => $2))
        WHERE id = $1`,
      [session.id, agentSessions.TURN_LEASE_STALE_SECONDS + 30]
    );
    assert.equal(await acquire('turn-d'), true, 'a lease its process never released goes stale');
    const { rows: [row] } = await client.query('SELECT active_turn FROM agent_sessions WHERE id = $1', [session.id]);
    assert.equal(row.active_turn.id, 'turn-d');
    await release('turn-b');
    assert.equal((await client.query('SELECT active_turn FROM agent_sessions WHERE id = $1', [session.id])).rows[0].active_turn.id,
      'turn-d', 'the turn that lost its lease cannot release its successor\'s');
    await release('turn-d');

    await agentSessions.archiveAgentSession(client, { userId: 7, id: session.id });
    assert.equal(await acquire('turn-e'), false, 'an archived conversation takes no turns');
  } finally {
    await done(client);
  }
});

test('stop intent is durable and idempotent; a recovered coding job blocks a new lease on every connection', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const other = schemaPool();
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const args = { agentSessionId: session.id, userId: 7, turnId: 'old-turn' };
    assert.equal(await agentSessions.acquireTurnLease(client, args), true);
    const first = await agentSessions.markTurnStopRequested(client, { ...args, by: 'ada' });
    const again = await agentSessions.markTurnStopRequested(other, { ...args, by: 'other-device' });
    assert.equal(again.stopRequestedAt, first.stopRequestedAt);
    assert.equal(again.stopRequestedBy, 'ada');
    assert.equal((await agentSessions.readState(other, { userId: 7, id: session.id })).lease.stopping, true);
    assert.equal(await agentSessions.markTurnStopRequested(client, { ...args, userId: 8 }), null);
    await agentSessions.releaseTurnLease(client, args);
    const job = { turnId: 'coding-1', mode: 'build', stopRequestedAt: first.stopRequestedAt };
    const { rows: [change] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id, agent_session_id, active_turn) VALUES (3, 7, $1, $2::jsonb) RETURNING id',
      [session.id, JSON.stringify(job)],
    );
    await client.query('UPDATE agent_sessions SET active_change_id = $1 WHERE id = $2', [change.id, session.id]);
    assert.equal(await agentSessions.acquireTurnLease(other, { ...args, turnId: 'new-turn' }), false,
      'the Mayor lease is gone but its coding job still exists');
    await client.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [change.id]);
    assert.equal(await agentSessions.acquireTurnLease(other, { ...args, turnId: 'new-turn' }), true);
    assert.equal(await agentSessions.markTurnStopRequested(client, { ...args, by: 'late-device' }), null,
      'an old stop cannot stamp the replacement turn');
  } finally { await other.end(); await done(client); }
});

test('a lease its turn stopped renewing is not busy, and only such a lease is handed back', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const detail = () => agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    const listed = async () => (await agentSessions.listAgentSessions(client, { userId: 7 })).sessions.find((s) => s.id === session.id);
    const age = (secs) => client.query(
      `UPDATE agent_sessions
          SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW() - make_interval(secs => $2))
        WHERE id = $1`,
      [session.id, secs]
    );
    const handBack = (userId = 7, finished = true) => agentSessions.releaseStaleTurnLease(client, { agentSessionId: session.id, userId, finished });

    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'dead-turn' }), true);
    assert.equal(await handBack(), false, 'a live lease may be a turn on the other pod');
    assert.equal((await detail()).busy, true);

    await age(agentSessions.TURN_LEASE_STALE_SECONDS + 30);
    assert.deepEqual([(await detail()).busy, (await listed()).busy], [false, false],
      'its process died: the detail and the lists stop saying working');
    assert.equal(await handBack(8), false, 'another user\'s hand-back clears nothing');
    assert.equal(await handBack(), true);
    const { rows: [row] } = await client.query('SELECT active_turn, last_done_at FROM agent_sessions WHERE id = $1', [session.id]);
    assert.equal(row.active_turn, null);
    assert.ok(row.last_done_at, 'a recovery that posted the wrap-up finished the dead turn\'s work');
    assert.equal((await detail()).doneUnseen, true);
    assert.equal(await handBack(), false, 'nothing left to hand back');

    // A stale lease still on the row: the dot shows, and reading clears it.
    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'dead-again' }), true);
    await age(agentSessions.TURN_LEASE_STALE_SECONDS + 30);
    assert.equal((await listed()).doneUnseen, true);
    assert.equal(await agentSessions.markSeen(client, { userId: 7, id: session.id }), true,
      'the other tabs hear the dot went, as they do once a turn releases');
  } finally {
    await done(client);
  }
});

test('a change names the open conversations it is the active change of', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    await client.query("INSERT INTO users (id, username) VALUES (7, 'ada') ON CONFLICT DO NOTHING");
    await client.query("INSERT INTO apps (id, slug, name, created_by) VALUES (1, 'rss', 'RSS', 7) ON CONFLICT DO NOTHING");
    const { rows: [change] } = await client.query('INSERT INTO chat_sessions (app_id, user_id) VALUES (1, 7) RETURNING id');
    const open = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const archived = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await client.query('UPDATE agent_sessions SET active_change_id = $1 WHERE id = ANY($2)', [change.id, [open.id, archived.id]]);
    await agentSessions.archiveAgentSession(client, { userId: 7, id: archived.id });
    assert.deepEqual(await agentSessions.conversationsOfChange(client, change.id), [{ agentSessionId: open.id, userId: 7 }]);
  } finally {
    await done(client);
  }
});

test('the lists\' marks: working while a turn runs, finished until the owner reads it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const listed = async () => (await agentSessions.listAgentSessions(client, { userId: 7 })).sessions.find((s) => s.id === session.id);
    const read = () => agentSessions.markSeen(client, { userId: 7, id: session.id });

    assert.deepEqual([(await listed()).busy, (await listed()).doneUnseen], [false, false], 'a new conversation has no mark');
    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'turn-a' }), true);
    assert.deepEqual([(await listed()).busy, (await listed()).doneUnseen], [true, false], 'working');
    await agentSessions.releaseTurnLease(client, { agentSessionId: session.id, turnId: 'turn-a', finished: true });
    assert.deepEqual([(await listed()).busy, (await listed()).doneUnseen], [false, true], 'finished, and not read since');

    assert.equal(await agentSessions.markSeen(client, { userId: 8, id: session.id }), false, 'another user reads nothing of it');
    assert.equal((await listed()).doneUnseen, true);
    assert.equal(await read(), true, 'reading it clears the dot, and says so');
    assert.equal((await listed()).doneUnseen, false);
    assert.equal(await read(), false, 'a second read clears nothing');

    // A lease handed back before its turn ran (no Mayor, no payer) finished nothing.
    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'turn-b' }), true);
    await agentSessions.releaseTurnLease(client, { agentSessionId: session.id, turnId: 'turn-b' });
    assert.equal((await listed()).doneUnseen, false, 'a refused turn leaves no dot');

    // Read mid-turn, finished after: the dot is the turn's.
    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'turn-c' }), true);
    await read();
    await client.query("UPDATE agent_sessions SET seen_at = NOW() - interval '1 second' WHERE id = $1", [session.id]);
    await agentSessions.releaseTurnLease(client, { agentSessionId: session.id, turnId: 'turn-c', finished: true });
    const got = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.deepEqual([got.busy, got.doneUnseen], [false, true], 'the detail read says the same as the list');
  } finally {
    await done(client);
  }
});

test('the Mayor switches between its own open changes only', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const { rows: [first] } = await client.query(
      "INSERT INTO chat_sessions (app_id, user_id, pr_number) VALUES (3, 7, 910) RETURNING *"
    );
    await agentSessions.linkChange(client, { agentSessionId: session.id, userId: 7, change: first });
    // Nothing is active, so the switch parks nothing.
    await client.query('UPDATE agent_sessions SET active_change_id = NULL, focus_app_id = NULL WHERE id = $1', [session.id]);

    const switched = await agentSessions.switchActiveChange(client, { agentSessionId: session.id, userId: 7, changeId: first.id });
    assert.equal(switched.changed, true);
    const detail = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(detail.activeChange.id, first.id);
    assert.equal(detail.focusApp.slug, 'recipe-box', 'the focus follows the change');
    const { messages } = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.equal(messages.at(-1).content, `Switched to PR #910 (change ${first.id}).`);
    assert.equal(messages.at(-1).metadata.agentSessionEvent, 'change_switched');

    assert.equal((await agentSessions.switchActiveChange(client, { agentSessionId: session.id, userId: 7, changeId: first.id })).changed, false);
    await assert.rejects(agentSessions.switchActiveChange(client, { agentSessionId: session.id, userId: 8, changeId: first.id }),
      (err) => err.status === 404, 'another user cannot move it');

    const { rows: [loose] } = await client.query("INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING id");
    await assert.rejects(agentSessions.switchActiveChange(client, { agentSessionId: session.id, userId: 7, changeId: loose.id }),
      (err) => err.status === 404, 'a change this conversation did not start');
    await client.query("UPDATE chat_sessions SET status = 'merged' WHERE id = $1", [first.id]);
    await client.query('UPDATE agent_sessions SET active_change_id = NULL WHERE id = $1', [session.id]);
    await assert.rejects(agentSessions.switchActiveChange(client, { agentSessionId: session.id, userId: 7, changeId: first.id }),
      (err) => err.status === 409, 'a merged change stays closed');
  } finally {
    await done(client);
  }
});

test('the sweeper drops delegations a week after they ended, with their tokens', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    await client.query(`
      ALTER TABLE mcp_delegations ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                  ADD COLUMN revoked_at TIMESTAMPTZ;
      CREATE TABLE mcp_tokens (id SERIAL PRIMARY KEY, grant_id TEXT NOT NULL);
      INSERT INTO mcp_delegations (grant_id, expires_at, revoked_at) VALUES
        ('expired-long-ago', NOW() - interval '8 days', NULL),
        ('revoked-long-ago', NOW() + interval '1 day', NOW() - interval '8 days'),
        ('expired-recently', NOW() - interval '6 days', NULL),
        ('live', NOW() + interval '1 hour', NULL);
      INSERT INTO mcp_tokens (grant_id) VALUES
        ('expired-long-ago'), ('revoked-long-ago'), ('expired-recently'), ('live');
    `);
    assert.equal(await mcpOauth.pruneDelegations(pool), 2);
    const { rows: grants } = await client.query('SELECT grant_id FROM mcp_delegations ORDER BY grant_id');
    assert.deepEqual(grants.map((r) => r.grant_id), ['expired-recently', 'live'],
      'a recent grant stays, for the audit trail and the refusal message');
    const { rows: tokens } = await client.query('SELECT grant_id FROM mcp_tokens ORDER BY grant_id');
    assert.deepEqual(tokens.map((r) => r.grant_id), ['expired-recently', 'live']);
    assert.equal(await mcpOauth.pruneDelegations(pool), 0, 'and a second sweep finds nothing');
  } finally {
    await done(client, pool);
  }
});

// Files sent in a conversation (#2779 follow-up) reuse the dev chat's table:
// a row names a change (session_id) or a conversation (agent_session_id),
// never neither, and goes with whichever it names.
function attachmentsMigration() {
  const table = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS chat_session_attachments ('));
  const create = table.slice(0, table.indexOf(');') + 2);
  const start = SCHEMA.indexOf('-- Files attached to an agent-session message (#2779 follow-up)');
  assert.ok(start > 0, 'the attachments block must be findable in schema.sql');
  const marker = 'ON chat_session_attachments(agent_session_id) WHERE agent_session_id IS NOT NULL;';
  const end = SCHEMA.indexOf(marker, start);
  assert.ok(end > start, 'and its end');
  return { create, block: SCHEMA.slice(start, end + marker.length) };
}

test('a conversation\'s files name it, not a change, and go with it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const { create, block } = attachmentsMigration();
    await client.query(create);
    const { rows: [change] } = await client.query('INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING id');
    await client.query(
      `INSERT INTO chat_session_attachments (id, session_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ('dev', $1, 7, 'text', 'a.txt', 'text/plain', 1, 'x')`, [change.id]
    );
    await client.query(block);
    await client.query(block);
    const { rows: checks } = await client.query(
      "SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'chat_session_attachments_owner_chk'"
    );
    assert.equal(checks[0].n, 1, 'idempotent, and a dev-chat row from before it still satisfies it');

    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await client.query(
      `INSERT INTO chat_session_attachments (id, agent_session_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ('conv', $1, 7, 'image', 'b.png', 'image/png', 1, 'x')`, [session.id]
    );
    await assert.rejects(client.query(
      `INSERT INTO chat_session_attachments (id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ('none', 7, 'text', 'c.txt', 'text/plain', 1, 'x')`
    ), /chat_session_attachments_owner_chk/, 'a row must name one or the other');
    await client.query('DELETE FROM agent_sessions WHERE id = $1', [session.id]);
    const { rows: left } = await client.query('SELECT id FROM chat_session_attachments ORDER BY id');
    assert.deepEqual(left.map((r) => r.id), ['dev'], 'the conversation\'s files go with it');
  } finally {
    await done(client);
  }
});

// ── Keeping every screen in step (the version, revs, notices, sends) ────

test('every write a screen draws bumps the conversation\'s version, once per statement, and announces it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const listener = new Client({ connectionString: DATABASE_URL });
  const heard = [];
  try {
    await listener.connect();
    listener.on('notification', (msg) => heard.push(JSON.parse(msg.payload)));
    await listener.query('LISTEN usernode_ws');
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const version = async () => Number((await client.query('SELECT state_version FROM agent_sessions WHERE id = $1', [session.id])).rows[0].state_version);
    const moves = async (label, sql, params = []) => {
      const before = await version();
      await client.query(sql, params);
      return [label, (await version()) - before];
    };
    const steps = [
      await moves('a message', `INSERT INTO chat_session_messages (agent_session_id, role, content) VALUES ($1, 'user', 'hi')`, [session.id]),
      await moves('three in one statement', `INSERT INTO chat_session_messages (agent_session_id, role, content)
        SELECT $1, 'system', 'n' || g FROM generate_series(1, 3) g`, [session.id]),
      await moves('an edit', `UPDATE chat_session_messages SET metadata = '{"x":1}' WHERE agent_session_id = $1 AND role = 'user'`, [session.id]),
      await moves('a turn starting', `UPDATE agent_sessions SET active_turn = jsonb_build_object('id', 't1', 'startedAt', NOW()) WHERE id = $1`, [session.id]),
      await moves('its lease renewed', `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW()) WHERE id = $1`, [session.id]),
      await moves('its phase', `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('phase', 'cc') WHERE id = $1`, [session.id]),
      await moves('a read (seen)', 'UPDATE agent_sessions SET seen_at = NOW() WHERE id = $1', [session.id]),
      await moves('the turn ending', 'UPDATE agent_sessions SET active_turn = NULL, last_done_at = NOW() WHERE id = $1', [session.id]),
      await moves('the title', `UPDATE agent_sessions SET title = 'Blue header' WHERE id = $1`, [session.id]),
    ];
    assert.deepEqual(steps, [
      ['a message', 1], ['three in one statement', 1], ['an edit', 1], ['a turn starting', 1],
      ['its lease renewed', 0], ['its phase', 1], ['a read (seen)', 0], ['the turn ending', 1], ['the title', 1],
    ]);

    // The active change moving on its own (its checks, its preview, its vote).
    const { rows: [change] } = await client.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, agent_session_id) VALUES (3, 7, 'active', $1) RETURNING id`, [session.id]);
    let before = await version();
    await client.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [change.id]);
    assert.equal(await version(), before + 1, 'a change\'s checks are the conversation\'s news');
    before = await version();
    await client.query(`UPDATE chat_sessions SET source = 'x' WHERE id = $1`, [change.id]);
    assert.equal(await version(), before, 'its bookkeeping is not');

    // Edited rows are re-stamped, so "since rev N" finds them.
    const { rows: revs } = await client.query(
      'SELECT id, rev FROM chat_session_messages WHERE agent_session_id = $1 ORDER BY id', [session.id]);
    assert.ok(Number(revs[0].rev) > Number(revs[3].rev), 'the edited first row carries the newest rev');

    await new Promise((resolve) => setTimeout(resolve, 200));
    const mine = heard.filter((n) => n.d && n.d.agentSessionId === session.id);
    assert.ok(mine.length >= 8, 'one notice per bump');
    const last = mine[mine.length - 1];
    // services/ws-bus.js's own envelope: every instance delivers it once.
    assert.deepEqual(Object.keys(last).sort(), ['d', 'i', 'k', 'r']);
    assert.equal(last.k, 'user');
    assert.deepEqual(last.r, { userId: 7 });
    assert.equal(last.d.type, 'agent_session_changed');
    assert.equal(last.d.version, await version());
    assert.equal(typeof last.d.busy, 'boolean');
  } finally {
    await listener.end().catch(() => {});
    await done(client);
  }
});

test('a message and its turn are written together, before any stream; a busy conversation or a repeated send writes nothing', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const start = (turnId, clientMessageId, text = 'Make it blue') => agentSessions.startTurnWithMessage(pool, {
      agentSessionId: session.id, userId: 7, turnId, text, clientMessageId, title: 'Make it blue',
    });
    const first = await start('turn-1', 'c-first-message');
    assert.equal(first.ok, true);
    const { rows: [row] } = await client.query('SELECT * FROM chat_session_messages WHERE id = $1', [first.messageId]);
    assert.deepEqual([row.role, row.content, row.client_message_id, row.metadata.agentTurnId], ['user', 'Make it blue', 'c-first-message', 'turn-1']);
    const { rows: [s1] } = await client.query('SELECT active_turn, title FROM agent_sessions WHERE id = $1', [session.id]);
    assert.deepEqual([s1.active_turn.id, s1.title], ['turn-1', 'Make it blue'], 'the lease and the title with it');

    assert.deepEqual(await start('turn-2', 'c-first-message'), { duplicate: true, messageId: first.messageId, turnId: 'turn-1' },
      'sent again after a dropped connection: recognised, and no second turn');
    assert.deepEqual(await start('turn-3', 'c-second-message', 'and green'), { busy: true }, 'the Mayor is answering: refused');
    const { rows: count } = await client.query('SELECT COUNT(*)::int AS n FROM chat_session_messages WHERE agent_session_id = $1', [session.id]);
    assert.equal(count[0].n, 1, 'neither wrote a row');

    // The same message sent twice at once, once the conversation is free.
    await agentSessions.releaseTurnLease(client, { agentSessionId: session.id, turnId: 'turn-1', finished: true });
    const raced = await Promise.all([start('turn-4', 'c-raced'), start('turn-5', 'c-raced')]);
    const kinds = raced.map((r) => (r.ok ? 'ok' : r.duplicate ? 'duplicate' : 'busy')).sort();
    assert.ok(kinds.includes('ok'), JSON.stringify(raced));
    assert.ok(!kinds.every((k) => k === 'ok'), 'never two turns for one message');
    const { rows: racedRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM chat_session_messages WHERE agent_session_id = $1 AND client_message_id = 'c-raced'`, [session.id]);
    assert.equal(racedRows[0].n, 1);
  } finally {
    await done(client, pool);
  }
});

test('the state read is one snapshot: unchanged when the screen is current, the rows changed since its rev otherwise', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await client.query(`INSERT INTO chat_session_messages (agent_session_id, role, content) VALUES ($1, 'user', 'one'), ($1, 'assistant', 'two')`, [session.id]);
    const whole = await agentSessions.readState(pool, { userId: 7, id: session.id });
    assert.equal(whole.full, true);
    assert.deepEqual(whole.messages.map((m) => m.content), ['one', 'two']);
    assert.equal(whole.version, whole.session.version);
    assert.equal(await agentSessions.readState(pool, { userId: 8, id: session.id }), null, 'another user\'s conversation reads as none');

    const current = await agentSessions.readState(pool, { userId: 7, id: session.id, version: whole.version, rev: whole.rev });
    assert.deepEqual(current, { unchanged: true, version: whole.version, busy: false, lease: null, stale: false, activeChangeId: null });

    await client.query(`UPDATE chat_session_messages SET content = 'one, edited' WHERE agent_session_id = $1 AND role = 'user'`, [session.id]);
    await client.query(`INSERT INTO chat_session_messages (agent_session_id, role, content) VALUES ($1, 'user', 'three')`, [session.id]);
    await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'turn-9' });
    const since = await agentSessions.readState(pool, { userId: 7, id: session.id, version: whole.version, rev: whole.rev });
    assert.equal(since.full, false);
    assert.deepEqual(since.messages.map((m) => m.content), ['one, edited', 'three'], 'the edited row and the new one, not the rest');
    assert.equal(since.session.busy, true);
    assert.deepEqual([since.lease.id, since.lease.phase], ['turn-9', 'mayor'], 'the running turn, for a screen on any pod');
    assert.ok(since.version > whole.version && since.rev > whole.rev);
  } finally {
    await done(client, pool);
  }
});

test('a turn left behind by its process is ended once, with a note the screen offers Retry on; a live one never', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'dead' });
    const end = (stale = true) => agentSessions.endInterruptedTurn(pool, {
      agentSessionId: session.id, turnId: 'dead', content: 'Interrupted.', stale,
    });
    assert.deepEqual(await agentSessions.staleTurnLeases(client), [], 'a live lease is nobody\'s to end');
    assert.equal(await end(), false);

    await client.query(
      `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW() - make_interval(secs => $2)) WHERE id = $1`,
      [session.id, agentSessions.TURN_LEASE_STALE_SECONDS + 30]);
    const [stale] = await agentSessions.staleTurnLeases(client);
    assert.deepEqual(stale, { agentSessionId: session.id, userId: 7, turnId: 'dead', activeChangeId: null, changeTurn: false });
    assert.equal((await agentSessions.staleTurnLeases(client, { agentSessionId: session.id })).length, 1, 'a read of the conversation finds it');
    assert.deepEqual(await agentSessions.staleTurnLeases(client, { agentSessionId: session.id + 1 }), [], 'and only it');
    assert.equal(await end(), true);
    assert.equal(await end(), false, 'a second sweeper finds it already ended');
    const { rows: notes } = await client.query(
      `SELECT content, metadata FROM chat_session_messages WHERE agent_session_id = $1 AND role = 'system'`, [session.id]);
    assert.deepEqual(notes.map((n) => [n.content, n.metadata.agentSessionEvent, n.metadata.retryable, n.metadata.agentTurnId]),
      [['Interrupted.', 'turn_interrupted', true, 'dead']], 'one note, with the lease handed back in the same transaction');
    assert.equal((await client.query('SELECT active_turn FROM agent_sessions WHERE id = $1', [session.id])).rows[0].active_turn, null);

    // A shutting-down process ends its own live turn.
    await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'dead' });
    assert.equal(await end(false), true);

    // Acquire the conversation first, then dispatch its coding job, as the
    // real flow does. A job already on record correctly refuses a new lease.
    assert.equal(await agentSessions.acquireTurnLease(client, { agentSessionId: session.id, userId: 7, turnId: 'building' }), true);
    // A build the dead turn dispatched is restart recovery's to hand back.
    const { rows: [change] } = await client.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, agent_session_id, active_turn) VALUES (3, 7, 'active', $1, '{"phase":"executing"}') RETURNING id`,
      [session.id]);
    await client.query('UPDATE agent_sessions SET active_change_id = $2 WHERE id = $1', [session.id, change.id]);
    await client.query(
      `UPDATE agent_sessions SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW() - make_interval(secs => $2)) WHERE id = $1`,
      [session.id, agentSessions.TURN_LEASE_STALE_SECONDS + 30]);
    assert.equal((await agentSessions.staleTurnLeases(client))[0].changeTurn, true);
  } finally {
    await done(client, pool);
  }
});
