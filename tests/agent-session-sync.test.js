'use strict';

// Agent chats keep every screen in step with the server (the overhaul after
// "a sent message flashes away and comes back", "messages only update after
// leaving the chat", "a message that looked sent never was").
//
//   1. The database announces every write a screen draws, in ws-bus.js's own
//      envelope, so every pod delivers it (schema.sql).
//   2. The turn route writes the message with its turn, before any stream,
//      recognises a resend, and refuses without writing anything.
//   3. The screen reads one consistent snapshot whenever it may be behind, and
//      a sent message is drawn at once and replaced in place: never absent
//      from the screen, never there twice.
//
// Run with: node --test tests/agent-session-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. The notice ──────────────────────────────────────────────────────

test('the database\'s notice is ws-bus.js\'s own envelope, on its channel, and agrees on the stale window', () => {
  const schema = read('src/db/schema.sql');
  const announce = schema.slice(schema.indexOf('CREATE OR REPLACE FUNCTION agent_session_state_announce()'));
  const bus = read('src/services/ws-bus.js');
  const channel = /const CHANNEL = '([^']+)';/.exec(bus)[1];
  assert.match(announce, new RegExp(`pg_notify\\('${channel}', json_build_object\\(`), 'the channel every instance LISTENs on');
  assert.match(bus, /return \{ i: INSTANCE_ID, k: kind, r: routing \|\| null, d: data \};/, 'the envelope ws-bus reads');
  assert.match(announce, /'i', 'db:agent_sessions',\s*'k', 'user',\s*'r', json_build_object\('userId', NEW\.user_id\),\s*'d', json_build_object\(/);
  assert.match(read('src/services/ws.js'), /case 'user':\s*if \(r\.userId != null\) deliverToUser\(r\.userId, payload\);/);
  const seconds = Number(/interval '(\d+) seconds'/.exec(announce)[1]);
  assert.equal(seconds, require('../src/services/agent-sessions').TURN_LEASE_STALE_SECONDS);
});

// ── 2. The turn route ──────────────────────────────────────────────────

const poolMod = require('../src/db/pool');
const agentTurn = require('../src/services/mayor/agent-turn');

function recordingPool(handlers = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (new RegExp(pattern).test(sql)) return fn(sql, params);
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query, async connect() { return { query, release() {} }; } };
}

const SESSION_ROW = {
  id: 5, user_id: 7, title: 'Blue header', title_source: 'auto', status: 'open', focus_app_id: null,
  focus_context: {}, active_change_id: null, active_turn: null, state_version: 3,
  last_activity_at: new Date('2026-09-23T12:00:00Z'), created_at: new Date('2026-09-23T12:00:00Z'), archived_at: null,
};

async function withRoutes(handlers, fn) {
  const pool = recordingPool(handlers);
  const previous = poolMod.getPool;
  poolMod.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/agent-sessions')];
  const { agentSessionRoutes } = require('../src/routes/agent-sessions');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7, username: 'ada' }; next(); });
  app.use(agentSessionRoutes({}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, target, body) => {
    const res = await fetch(`${base}${target}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a stream */ }
    return { status: res.status, type: res.headers.get('content-type') || '', body: json, text };
  };
  try {
    await fn(call, pool);
  } finally {
    server.close();
    poolMod.getPool = previous;
    delete require.cache[require.resolve('../src/routes/agent-sessions')];
  }
}

test('the turn route: a resend is recognised and runs nothing; a refusal writes nothing; a busy conversation writes nothing', async () => {
  const saved = { runAgentTurn: agentTurn.runAgentTurn, resolveAgentMayor: agentTurn.resolveAgentMayor };
  const runs = [];
  let mayor = { ok: true };
  agentTurn.resolveAgentMayor = async () => mayor;
  agentTurn.runAgentTurn = async (args) => { runs.push(args); args.res.end(); };
  let leaseFree = true;
  let sent = null;
  try {
    await withRoutes({
      'FROM agent_sessions s': () => ({ rows: [SESSION_ROW] }),
      'client_message_id = \\$2': () => ({ rows: sent ? [sent] : [] }),
      'UPDATE agent_sessions\\s+SET active_turn = jsonb_build_object': () => ({ rows: leaseFree ? [{ id: 5 }] : [] }),
      'INSERT INTO chat_session_messages': () => ({ rows: [{ id: 41 }] }),
    }, async (call, pool) => {
      const writes = () => pool.calls.filter((c) => /INSERT INTO chat_session_messages|SET active_turn = jsonb_build_object/.test(c.sql)).length;

      assert.equal((await call('POST', '/api/agent-sessions/5/turns', { message: 'hi', clientMessageId: 'no spaces!' })).status, 400);
      assert.equal((await call('POST', '/api/agent-sessions/5/turns', { retry: true, message: 'hi' })).status, 400,
        'a retry sends no message of its own');

      const first = await call('POST', '/api/agent-sessions/5/turns', { message: 'Make it blue', clientMessageId: 'c-12345678' });
      assert.equal(first.status, 200);
      assert.match(first.type, /text\/event-stream/);
      assert.deepEqual(runs[0].recorded, { id: 41, clientMessageId: 'c-12345678' }, 'written with the lease, before the stream');
      assert.equal(writes(), 2);

      sent = { id: 41, turn_id: runs[0].turnId };
      const again = await call('POST', '/api/agent-sessions/5/turns', { message: 'Make it blue', clientMessageId: 'c-12345678' });
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, { accepted: true, duplicate: true, messageId: 41, turnId: runs[0].turnId },
        'the server already has it: answered, and no second turn');
      assert.equal(runs.length, 1);
      assert.equal(writes(), 2, 'nothing written again');
      sent = null;

      mayor = { ok: false, status: 429, code: 'budget_exceeded', error: 'Weekly limit reached.' };
      const refused = await call('POST', '/api/agent-sessions/5/turns', { message: 'and green', clientMessageId: 'c-87654321' });
      assert.deepEqual([refused.status, refused.body.code], [429, 'budget_exceeded']);
      assert.equal(writes(), 2, 'who pays is decided before anything is written');
      mayor = { ok: true };

      leaseFree = false;
      const busy = await call('POST', '/api/agent-sessions/5/turns', { message: 'and green', clientMessageId: 'c-87654321' });
      assert.deepEqual([busy.status, busy.body.busy], [409, true]);
      assert.ok(!pool.calls.slice(-3).some((c) => /INSERT INTO chat_session_messages/.test(c.sql)), 'refused with the lease: no message row');
      leaseFree = true;

      const retry = await call('POST', '/api/agent-sessions/5/turns', { retry: true });
      assert.equal(retry.status, 200);
      assert.deepEqual([runs[1].retry, runs[1].messageText, runs[1].recorded], [true, null, null]);
    });
  } finally {
    Object.assign(agentTurn, saved);
  }
});

test('the state route answers "unchanged" to a screen that is current, and the running turn from the lease otherwise', async () => {
  const lease = { id: 'turn-abcd-1', startedAt: '2026-09-23T12:00:00.000Z', renewedAt: '2026-09-23T12:00:10.000Z', phase: 'cc', phaseStartedAt: 1790000000000 };
  await withRoutes({
    'SELECT state_version, active_turn, active_change_id': () => ({ rows: [{ state_version: 4, active_turn: lease, active_change_id: null, turn_live: true }] }),
    'FROM agent_sessions s': () => ({ rows: [{ ...SESSION_ROW, state_version: 4, active_turn: lease, turn_live: true }] }),
    'COALESCE\\(MAX\\(rev\\), 0\\)': () => ({ rows: [{ rev: '12' }] }),
    'SELECT id FROM agent_sessions WHERE id = \\$1 AND user_id = \\$2': () => ({ rows: [{ id: 5 }] }),
    'FROM chat_session_messages\\s+WHERE agent_session_id = \\$1 AND id > \\$2': () => ({ rows: [
      { id: 40, session_id: null, role: 'user', content: 'hi', metadata: {}, created_at: null, client_message_id: 'c-12345678', rev: '12' },
    ] }),
  }, async (call) => {
    const current = await call('GET', '/api/agent-sessions/5/state?version=4&rev=12');
    assert.deepEqual(current.body, {
      unchanged: true, version: 4, busy: true, turn: { id: 'turn-abcd-1', phase: 'cc', startedAt: 1790000000000, stopping: false, stopRequestedAt: null, stopToken: 'agent:turn-abcd-1', changeId: null, canForceStop: false },
    }, 'the durable turn and stop controls a screen on any pod can draw');
    const whole = await call('GET', '/api/agent-sessions/5/state');
    assert.equal(whole.body.full, true);
    assert.equal(whole.body.version, 4);
    assert.equal(whole.body.rev, 12);
    assert.deepEqual(whole.body.messages.map((m) => [m.id, m.clientMessageId, m.rev]), [[40, 'c-12345678', 12]]);
    assert.equal(whole.body.busy, true);
    assert.equal(whole.body.turn.phase, 'cc');
    assert.ok(!('lease' in whole.body) && !('activeChangeId' in whole.body), 'internal fields stay internal');
  });
});

test('the state route ends a turn whose process died before answering, so the screen goes from working straight to Retry', async () => {
  const saved = agentTurn.sweepInterruptedTurns;
  const sweeps = [];
  let ended = false;
  agentTurn.sweepInterruptedTurns = async (args) => { sweeps.push(args.agentSessionId); ended = true; return 1; };
  const lease = { id: 'turn-dead-1', startedAt: '2026-09-23T12:00:00.000Z', renewedAt: '2026-09-23T12:00:10.000Z', phase: 'mayor' };
  const note = { id: 41, session_id: null, role: 'system', content: 'The Mayor was interrupted', metadata: { event: 'turn_interrupted', retryable: true }, created_at: null, client_message_id: null, rev: '13' };
  try {
    await withRoutes({
      // Stale until the sweep ends it; then a version later, and no lease.
      'SELECT state_version, active_turn, active_change_id': () => ({ rows: [ended
        ? { state_version: 5, active_turn: null, active_change_id: null, turn_live: false }
        : { state_version: 4, active_turn: lease, active_change_id: null, turn_live: false }] }),
      'FROM agent_sessions s': () => ({ rows: [{ ...SESSION_ROW, state_version: ended ? 5 : 4, active_turn: ended ? null : lease, turn_live: false }] }),
      'COALESCE\\(MAX\\(rev\\), 0\\)': () => ({ rows: [{ rev: ended ? '13' : '12' }] }),
      'SELECT id FROM agent_sessions WHERE id = \\$1 AND user_id = \\$2': () => ({ rows: [{ id: 5 }] }),
      'WHERE agent_session_id = \\$1 AND rev > \\$2': () => ({ rows: ended ? [note] : [] }),
    }, async (call) => {
      const polled = await call('GET', '/api/agent-sessions/5/state?version=4&rev=12');
      assert.deepEqual(sweeps, [5], 'the one conversation, swept on the read');
      assert.equal(polled.body.unchanged, false, 'the answer is the conversation after the sweep, not "unchanged"');
      assert.equal(polled.body.version, 5);
      assert.equal(polled.body.busy, false);
      assert.deepEqual(polled.body.messages.map((m) => m.id), [41], 'with the interrupted note');
      assert.ok(!('stale' in polled.body), 'internal fields stay internal');
      await call('GET', '/api/agent-sessions/5/state?version=5&rev=13');
      assert.deepEqual(sweeps, [5], 'a conversation with no stale lease is not swept');
    });
  } finally {
    agentTurn.sweepInterruptedTurns = saved;
  }
});

// ── 3. The screen ──────────────────────────────────────────────────────

const encoder = new TextEncoder();
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * A server with the real read semantics: a version counted by writes, rows
 * stamped with a rev on write and edit, "unchanged" for a current screen,
 * the rows since a rev otherwise, and turns that write their rows.
 */
function fakeServer() {
  const server = {
    version: 1,
    rev: 1,
    busy: false,
    turn: null,
    messages: [{ id: 10, role: 'user', content: 'Earlier', metadata: {}, createdAt: null, clientMessageId: null, rev: 1 }],
    reads: [],
    posts: [],
    // What a POST .../turns does, set per test.
    onTurn: null,
  };
  const write = (rows) => {
    for (const row of rows) {
      server.rev += 1;
      server.messages.push({ metadata: {}, createdAt: null, clientMessageId: null, ...row, rev: server.rev });
    }
    server.version += 1;
  };
  server.write = write;
  const session = () => ({
    id: 7, title: 'x', status: 'open', focusApp: null, focusContext: {}, busy: server.busy, activeChange: null, changes: [],
    version: server.version,
  });
  const json = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  server.fetch = async (url, init = {}) => {
    if (/\/turns$/.test(url) && init.method === 'POST') {
      const body = JSON.parse(init.body);
      server.posts.push(body);
      return server.onTurn(body);
    }
    if (/\/stop$/.test(url) && init.method === 'POST') return server.onStop(JSON.parse(init.body));
    const state = /\/api\/agent-sessions\/7\/state(?:\?(.*))?$/.exec(url);
    if (state) {
      const query = new URLSearchParams(state[1] || '');
      server.reads.push(Object.fromEntries(query));
      const turn = server.busy ? server.turn : null;
      if (query.get('version') && Number(query.get('version')) === server.version) {
        return json({ unchanged: true, version: server.version, busy: server.busy, turn });
      }
      const since = query.get('rev');
      const rows = since ? server.messages.filter((m) => m.rev > Number(since)) : server.messages;
      return json({
        unchanged: false, version: server.version, busy: server.busy, turn, session: session(),
        messages: rows.map((m) => ({ ...m })), full: !since, nextAfter: null, rev: server.rev, actions: [],
      });
    }
    if (/\/drafts$/.test(url)) return json({ drafts: [] });
    if (/\/api\/agent-sessions$/.test(url)) return json({ sessions: [session()] });
    return json({});
  };
  return server;
}

const stream = (events) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'text/event-stream' },
  body: new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(frame(event)));
      controller.close();
    },
  }),
});

function world(server) {
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, PlatformUI: { toast() {} } };
  globalThis.EventSource = class { constructor(url) { this.url = url; } close() { this.closed = true; } };
  globalThis.fetch = server.fetch;
  // The store's hooks, run by hand: the test subscribes to every publish.
  let subscribeTo = null;
  const react = {
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (subscribe, get) => { subscribeTo = subscribe; return get(); },
  };
  const store = loadTsx('frontend/src/features/agent-session/store.ts', { stubs: { react } });
  store.useAgentSessionState();
  return { store, subscribe: (listener) => subscribeTo(listener) };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.fetch;
  delete globalThis.EventSource;
}

test('a sent message is on screen from the moment it is sent, once, until the server\'s row replaces it in place', async () => {
  const server = fakeServer();
  server.onTurn = (body) => {
    // The server writes the message with its turn, answers, and finishes.
    server.busy = true;
    server.turn = { id: 'turn-aaaa-1', phase: 'mayor', startedAt: 1 };
    server.write([{ id: 11, role: 'user', content: body.message, clientMessageId: body.clientMessageId }]);
    server.write([{ id: 12, role: 'assistant', content: 'Done: it is blue.' }]);
    server.busy = false;
    server.version += 1;
    return stream([
      { type: 'accepted', messageId: 11, clientMessageId: body.clientMessageId, turnId: 'turn-aaaa-1', _seq: 'turn-aaa-1' },
      { type: 'token', text: 'Done: it is blue.', _seq: 'turn-aaa-2' },
      { type: 'mayor_reasoning', messageId: 12, text: 'Done: it is blue.', _seq: 'turn-aaa-3' },
      { type: 'done', _seq: 'turn-aaa-4' },
    ]);
  };
  const { store, subscribe } = world(server);
  try {
    await store.openAgentSession({ id: 7, host: 'messages' });
    const seen = [];
    subscribe(() => {
      const s = store.getAgentSessionState();
      const asMessage = s.messages.filter((m) => m.content === 'Make it blue').length;
      const asOutbox = s.outbox.filter((o) => o.shown === 'Make it blue').length;
      seen.push(asMessage + asOutbox);
      const reply = s.messages.some((m) => m.id === 12) || s.turn.streamText.includes('it is blue');
      if (asMessage) seen.push(reply ? 'reply-shown' : 'reply-missing');
    });
    await store.sendAgentMessage('Make it blue');
    await store.requestSync(7);
    assert.ok(seen.length > 2);
    assert.ok(seen.filter((n) => typeof n === 'number').every((n) => n === 1),
      `the message is on screen exactly once at every publish, never gone and never twice: ${JSON.stringify(seen)}`);
    assert.ok(!seen.includes('reply-missing') || seen.lastIndexOf('reply-missing') < seen.indexOf('reply-shown'),
      'the reply, once shown, never flashes away');
    const s = store.getAgentSessionState();
    assert.deepEqual(s.messages.map((m) => m.id), [10, 11, 12]);
    assert.deepEqual(s.outbox, []);
    assert.equal(s.turn.running, false);
    assert.equal(s.turn.streamText, '');
    assert.equal(server.posts[0].clientMessageId, s.messages[1].clientMessageId);
  } finally {
    cleanup();
  }
});

test('the screen reads again only when behind: an older or equal version is ignored, a newer one is read, only what changed', async () => {
  const server = fakeServer();
  const { store } = world(server);
  try {
    await store.openAgentSession({ id: 7, host: 'messages' });
    assert.deepEqual(server.reads, [{}], 'the first read is whole');
    server.reads.length = 0;

    store.agentSessionListChanged({ agentSessionId: 7, version: server.version });
    await store.requestSync(7).catch(() => {});
    server.reads.length = 0;
    store.agentSessionListChanged({ agentSessionId: 7, version: server.version - 1 });
    store.agentSessionListChanged({ agentSessionId: 99, version: 500 });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(server.reads, [], 'a version it holds, or another conversation\'s: nothing to read');

    // Another device: a message edited and one added.
    server.messages[0] = { ...server.messages[0], content: 'Earlier, edited', rev: server.rev + 1 };
    server.rev += 1;
    server.write([{ id: 13, role: 'assistant', content: 'From the other tab' }]);
    store.agentSessionListChanged({ agentSessionId: 7, version: server.version });
    for (let i = 0; i < 20 && store.getAgentSessionState().version !== server.version; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    assert.equal(server.reads.length, 1, 'one read for one notice');
    assert.ok(server.reads[0].rev && server.reads[0].version, 'it says what it holds, and gets only what moved');
    assert.deepEqual(store.getAgentSessionState().messages.map((m) => [m.id, m.content]),
      [[10, 'Earlier, edited'], [13, 'From the other tab']]);
  } finally {
    cleanup();
  }
});

test('a screen that believes the Mayor is working settles on the server\'s word, with no event at all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = fakeServer();
  server.busy = true;
  server.turn = { id: 'turn-bbbb-2', phase: 'cc', startedAt: 5 };
  const { store } = world(server);
  try {
    await store.openAgentSession({ id: 7, host: 'messages' });
    let state = store.getAgentSessionState();
    assert.deepEqual([state.turn.running, state.turn.phase, state.turn.turnId], [true, 'cc', 'turn-bbbb-2'], 'working, as the server says');

    // The turn ends on another pod: no event ever reaches this screen, and
    // the lease going stale writes nothing (only `busy` moves).
    server.busy = false;
    server.write([{ id: 14, role: 'assistant', content: 'Built.' }]);
    server.version -= 1; // the read that follows is "unchanged", with busy false
    for (let i = 0; i < 30 && store.getAgentSessionState().turn.running; i += 1) {
      t.mock.timers.tick(4000);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    state = store.getAgentSessionState();
    assert.equal(state.turn.running, false, 'the poll while working found it over, and read it whole');
    assert.ok(state.messages.some((m) => m.id === 14));
  } finally {
    cleanup();
  }
});

test('a message refused because the Mayor is still answering is kept, Not sent; Retry sends it again under the same id', async () => {
  const server = fakeServer();
  let refuse = true;
  server.onTurn = (body) => {
    if (refuse) {
      return { ok: false, status: 409, headers: { get: () => 'application/json' }, json: async () => ({ error: 'The Mayor is already answering in this conversation.', busy: true }) };
    }
    server.write([{ id: 11, role: 'user', content: body.message, clientMessageId: body.clientMessageId }]);
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ accepted: true, duplicate: true, messageId: 11 }) };
  };
  const { store } = world(server);
  try {
    await store.openAgentSession({ id: 7, host: 'messages' });
    await store.sendAgentMessage('And make it green');
    let state = store.getAgentSessionState();
    assert.deepEqual(state.outbox.map((o) => [o.shown, o.status]), [['And make it green', 'failed']]);
    assert.match(state.outbox[0].error, /still answering/);
    assert.equal(state.returnedText, null);

    refuse = false;
    assert.equal(state.turn.running, false, 'refused: the screen is not left "working", with Send turned into Save');
    store.retryOutbox(state.outbox[0].clientId);
    for (let i = 0; i < 20 && store.getAgentSessionState().outbox.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    await store.requestSync(7);
    state = store.getAgentSessionState();
    assert.equal(server.posts[0].clientMessageId, server.posts[1].clientMessageId, 'the same message, the same id');
    assert.deepEqual(state.outbox, []);
    assert.deepEqual(state.messages.map((m) => m.id), [10, 11]);
  } finally {
    cleanup();
  }
});

test('the composer and the router keep it in step: the socket\'s return, the foreground and the network are reads, and the pane takes back a conversation nobody holds', () => {
  const store = read('frontend/src/features/agent-session/store.ts');
  assert.match(store, /window\.addEventListener\('online', wake\);/);
  assert.match(store, /document\.addEventListener\('visibilitychange', wake\);/);
  assert.match(store, /resync: resyncAgentSession,/);
  assert.match(read('public/js/app.js'), /window\.UsernodeReact\?\.agentSession\?\.resync\?\.\(\);/, 'app.js resyncCurrentView');
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /if \(shown && !held\) void openAgentSession\(\{ id, host: 'messages' \}\);/);
  // Leaving a conversation never cancels a send on its way.
  const deactivate = store.slice(store.indexOf('export function deactivateAgentSession()'));
  assert.doesNotMatch(deactivate.slice(0, deactivate.indexOf('\n}\n')), /\.abort\(\)/);
});


test('Stop state survives an unchanged poll, another device, and a fresh screen; only job completion restores Send', async () => {
  const server = fakeServer();
  server.busy = true;
  server.turn = { id: null, phase: 'cc', startedAt: Date.now(), stopToken: 'change:50:job-1', stopping: false };
  let stopCalls = 0;
  server.onStop = async (input) => {
    stopCalls += 1;
    assert.equal(input.token, server.turn.stopToken);
    server.turn = { ...server.turn, stopping: true, stopRequestedAt: Date.now() - 45_000, canForceStop: true };
    return { ok: true, status: 202, json: async () => ({ stopped: true, stopping: true, stopRequestedAt: server.turn.stopRequestedAt }) };
  };
  const first = world(server).store;
  const second = world(server).store;
  try {
    await first.openAgentSession({ id: 7, host: 'messages' });
    await second.openAgentSession({ id: 7, host: 'messages' });
    await first.stopAgentTurn();
    await second.requestSync(7);
    assert.equal(stopCalls, 1, 'one request owns the whole stop');
    for (const store of [first, second]) {
      const turn = store.getAgentSessionState().turn;
      assert.equal(turn.running, true);
      assert.equal(turn.stopping, true);
      assert.equal(turn.canForceStop, undefined, 'there is no delayed force-stop step');
      assert.equal(turn.stopRequestedAt, server.turn.stopRequestedAt);
    }
    const refreshed = world(server).store;
    await refreshed.openAgentSession({ id: 7, host: 'messages' });
    assert.equal(refreshed.getAgentSessionState().turn.stopRequestedAt, server.turn.stopRequestedAt);
    server.busy = false;
    server.turn = null;
    server.version += 1;
    for (const store of [first, second, refreshed]) {
      await store.requestSync(7);
      assert.equal(store.getAgentSessionState().turn.running, false);
      assert.equal(store.getAgentSessionState().turn.stopping, false);
    }
  } finally { cleanup(); }
});

test('a delayed stop failure cannot paint the replacement job as stopping or failed', async () => {
  const server = fakeServer();
  server.busy = true;
  server.turn = { phase: 'cc', stopToken: 'change:50:old-job', startedAt: Date.now() };
  let reply;
  server.onStop = () => new Promise((resolve) => { reply = resolve; });
  const { store } = world(server);
  try {
    await store.openAgentSession({ id: 7, host: 'messages' });
    const pending = store.stopAgentTurn();
    server.turn = { phase: 'cc', stopToken: 'change:50:new-job', startedAt: Date.now() };
    await store.requestSync(7);
    reply({ ok: false, status: 409, json: async () => ({ error: 'The old job ended.' }) });
    await pending;
    const turn = store.getAgentSessionState().turn;
    assert.equal(turn.stopToken, 'change:50:new-job');
    assert.equal(turn.stopping, false);
    assert.equal(turn.stopError, null);
    assert.equal(turn.stopPending, false);
  } finally { cleanup(); }
});
