'use strict';

// #3177 against the FULL PostgreSQL schema, in a throwaway database, through
// the real POST /api/sessions/:id/chat and GET /api/sessions/:id/status
// (src/routes/sessions.js, src/services/chat-delivery.js). The session has no
// repository, so each turn ends at once with a persisted status row and
// `done` (the tests/chat-repo-less-turn.test.js path).
//
// Pinned here, where a recording pool cannot reach:
//   * chat_session_messages.client_message_id and its per-session unique
//     index apply, twice (boot-idempotent);
//   * a retry with the same id stores nothing and runs no turn, and reports
//     the first turn as done;
//   * the insert's ON CONFLICT names the partial index PostgreSQL will infer,
//     so two retries that race past the lookup store ONE row;
//   * the delivery lookup answers only the session's owner or an admin.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/chat-delivery-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const CLIENT_ID = 'retry-3177-0001';

function parseSse(body) {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

test('chat delivery against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  // idleTimeoutMillis: 0 keeps pg from arming idle timers: the clock is
  // mocked below, and a real timer armed before that could not be cleared
  // through the mock, holding the process open after the test.
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, idleTimeoutMillis: 0 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `chat_delivery_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, idleTimeoutMillis: 0 });
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new column and index included

  // The first delivery lookup can be made to miss, which is what two
  // retries racing past it look like to the one that inserts second.
  let missNextLookup = false;
  const routePool = {
    query(sql, params) {
      if (missNextLookup && /m\.client_message_id = \$2/.test(String(sql))) {
        missNextLookup = false;
        return Promise.resolve({ rows: [] });
      }
      return pool.query(sql, params);
    },
  };
  require('../src/db/pool').getPool = () => routePool;
  require('../src/services/limits').resolveBillingPath = async () => ({ apiKey: null });
  require('../src/services/ws').broadcastGlobal = () => {};
  // The turn-done notification is not under test, and must not outlive it.
  require('../src/services/notifications').createSessionDoneNotification = async () => [];
  const { sessionRoutes } = require('../src/routes/sessions');

  await pool.query(`
    INSERT INTO users (id, username, password) VALUES (7, 'ada', 'x'), (8, 'bo', 'x'), (9, 'root', 'x');
    INSERT INTO apps (id, slug, name, created_by) VALUES (3, 'recipe-box', 'Recipe box', 7);
  `);
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status)
     VALUES (3, 7, 'dev/ada-1', 'active') RETURNING id`
  );

  let viewer = { id: 7, username: 'ada' };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = viewer; next(); });
  app.use(sessionRoutes({ jwtSecret: 's' }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sessions/${session.id}`;
  const send = async (body) => {
    const res = await fetch(`${base}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return parseSse(await res.text());
  };
  const delivery = async (id) => (await (await fetch(`${base}/status?client_message_id=${id}`)).json()).delivery;
  const userRows = async () => (await pool.query(
    `SELECT id, client_message_id FROM chat_session_messages
      WHERE session_id = $1 AND role = 'user' ORDER BY id`, [session.id]
  )).rows;

  // Each turn exit schedules a 30s bus cleanup; mocked only now, once the
  // database is up, so the connections above never saw a fake clock.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let firstAccepted = null;
  await t.test('the first send is stored with its id and accepted', async () => {
    const events = await send({ message: 'add a dark mode toggle', client_message_id: CLIENT_ID });
    [firstAccepted] = events;
    const rows = await userRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_message_id, CLIENT_ID);
    assert.deepEqual(events[0], {
      type: 'accepted', _seq: events[0]._seq, messageId: rows[0].id, clientMessageId: CLIENT_ID,
    });
    assert.ok(events.some((e) => e.type === 'done'));
  });

  await t.test('a retry stores nothing, runs nothing, and reports the turn done', async () => {
    const [first] = await userRows();
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_session_messages')).rows[0].n;
    const events = await send({ message: 'add a dark mode toggle', client_message_id: CLIENT_ID });
    assert.equal(events.length, 1);
    assert.equal(events[0].duplicate, true);
    assert.equal(events[0].messageId, first.id);
    assert.equal(events[0].state, 'done', 'the repo-less turn wrote its status row after the message');
    assert.equal(events[0]._seq, firstAccepted._seq, 'resumes from the first turn\'s accepted');
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM chat_session_messages')).rows[0].n;
    assert.equal(after, before, 'no user row, and no status row from a second turn');
  });

  await t.test('two retries racing past the lookup still store one row', async () => {
    missNextLookup = true;
    const events = await send({ message: 'add a dark mode toggle', client_message_id: CLIENT_ID });
    assert.equal(missNextLookup, false, 'the lookup was skipped, so the insert met the index');
    assert.equal(events.length, 1);
    assert.equal(events[0].duplicate, true);
    assert.equal((await userRows()).filter((r) => r.client_message_id === CLIENT_ID).length, 1);
  });

  await t.test('the same id is free in another session, and ids are optional', async () => {
    const { rows: [other] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status)
       VALUES (3, 7, 'dev/ada-2', 'active') RETURNING id`
    );
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, client_message_id)
       VALUES ($1, 'user', 'elsewhere', $2)`, [other.id, CLIENT_ID]
    );
    const events = await send({ message: 'no id this time' });
    assert.equal(events[0].type, 'accepted');
    assert.equal(events[0].clientMessageId, null);
    const rows = await userRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].client_message_id, null);
  });

  await t.test('GET /status: the owner and an admin are answered; anyone else gets 404', async () => {
    const [first] = await userRows();
    // The bus cleanup is on the mocked clock, so the turn is still buffered.
    assert.deepEqual(await delivery(CLIENT_ID), {
      clientMessageId: CLIENT_ID, received: true, messageId: first.id, state: 'done', since: firstAccepted._seq,
    });
    assert.deepEqual(await delivery('never-sent-0001'), { clientMessageId: 'never-sent-0001', received: false });

    // A non-owner of this unshared session is not answered at all: the
    // status route applies the session's visibility rule (canViewSession),
    // so the delivery receipt, like the rest of the status, is a 404.
    viewer = { id: 8, username: 'bo' };
    const denied = await fetch(`${base}/status?client_message_id=${CLIENT_ID}`);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: 'Session not found' });
    viewer = { id: 9, username: 'root', isAdmin: true };
    assert.equal((await delivery(CLIENT_ID)).received, true);
    viewer = { id: 7, username: 'ada' };
  });
});
