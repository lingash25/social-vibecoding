'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readWork, requestStop } = require('../src/services/agent-session-stop');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function fixture({ lease = null, job = { turnId: 'job-1', mode: 'build', startedAt: new Date().toISOString() }, local = null } = {}) {
  const row = { active_turn: lease, turn_live: !!lease, change_id: 50, active_change_id: 50, change_turn: job };
  const calls = [];
  const pool = { async query(sql, params) {
    if (sql.includes('FROM agent_sessions s')) return { rows: params[1] === 7 ? [structuredClone(row)] : [] };
    if (sql.includes('UPDATE agent_sessions SET active_turn')) {
      if (row.active_turn?.id !== params[2]) return { rows: [] };
      row.active_turn.stopRequestedAt ||= new Date().toISOString();
      return { rows: [{ active_turn: row.active_turn }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const deps = {
    mayor: { turnState: () => local, stopAgentTurn: (id, args) => calls.push(['mayor', id, args]), handBackOrphanedTurn: async () => true },
    registry: { get: () => null }, isChangeBusy: () => !!row.change_turn, activeTurnMode: () => null,
    stopJob: async (args) => {
      calls.push(['job', args]);
      row.change_turn.stopRequestedAt ||= new Date().toISOString();
      return { status: 202, body: { stopped: true, stopping: true } };
    },
  };
  const args = { pool, user: { id: 7, username: 'ada' }, agentSessionId: 5 };
  return { row, calls, pool, deps, args, read: () => readWork(pool, { agentSessionId: 5, userId: 7 }, deps) };
}

test('one server request stops a recovered job; fresh reads on both devices retain its original stop time', async () => {
  const f = fixture();
  const before = await f.read();
  assert.equal(before.busy, true);
  assert.equal(before.turn.stopping, false);
  const answer = await requestStop({ ...f.args, token: before.turn.stopToken }, f.deps);
  assert.equal(answer.status, 202);
  assert.equal(f.calls.filter((c) => c[0] === 'job').length, 1);
  assert.equal(f.calls.find((c) => c[0] === 'job')[1].expectedTurnId, 'job-1');
  const after = await f.read();
  assert.equal(after.busy, true, 'a stop request does not release a running job');
  assert.equal(after.turn.stopping, true);
  // New dependency objects model a different serving process: there is no
  // in-memory stop handle to recover the UI from.
  const otherDevice = await readWork(f.pool, { agentSessionId: 5, userId: 7 }, { ...f.deps, registry: { get: () => null } });
  assert.deepEqual(otherDevice.turn, after.turn);
  await requestStop(f.args, f.deps);
  assert.equal((await f.read()).turn.stopRequestedAt, after.turn.stopRequestedAt);
  f.row.change_turn = null;
  assert.deepEqual(await f.read(), { busy: false, turn: null, row: f.row });
});

test('the first Stop and every retry use immediate force, with no prior-stop deadline', async () => {
  const f = fixture();
  for (const force of [false, true]) {
    const fresh = await f.read();
    assert.equal(fresh.turn.canForceStop, false, 'there is no separate escalation control');
    assert.equal((await requestStop({ ...f.args, force, token: fresh.turn.stopToken }, f.deps)).status, 202);
    const job = f.calls.filter((c) => c[0] === 'job').at(-1)[1];
    assert.equal(job.force, true);
    assert.equal(job.immediate, true);
  }
});

test('a stale device cannot stop a replacement run; another owner cannot stop or force it', async () => {
  const f = fixture();
  const old = (await f.read()).turn.stopToken;
  f.row.change_turn.turnId = 'replacement';
  assert.equal((await requestStop({ ...f.args, token: old }, f.deps)).body.code, 'turn_changed');
  for (const force of [false, true]) {
    assert.equal((await requestStop({ ...f.args, user: { id: 8 }, force }, f.deps)).status, 404);
  }
  assert.equal(f.calls.length, 0);
});

test('stop failures are returned to the caller, never turned into success', async () => {
  for (const result of [
    { status: 503, body: { error: 'Could not stop worker' } },
    { status: 200, body: { stopped: false, reason: 'no active turn' } },
  ]) {
    const f = fixture();
    f.deps.stopJob = async () => result;
    const answer = await requestStop(f.args, f.deps);
    assert.ok(answer.status >= 400);
    assert.equal((await f.read()).busy, true);
  }
});

test('a chat-only stop is durable, and a final wrap-up remains protected', async () => {
  const f = fixture({ job: null, lease: { id: 'mayor-1', phase: 'mayor', startedAt: new Date().toISOString() } });
  assert.equal((await requestStop(f.args, f.deps)).status, 202);
  assert.equal((await f.read()).turn.stopping, true);
  assert.ok(f.row.active_turn.stopRequestedAt);
  assert.equal(f.calls.filter((c) => c[0] === 'job').length, 0);
  f.row.active_turn.phase = 'mayor2';
  const before = f.calls.length;
  assert.equal((await requestStop(f.args, f.deps)).body.reason, 'wrap_up_not_stoppable');
  assert.equal(f.calls.length, before);
});

test('a durable job stays busy on a process with no worker registry; shots do not block coding', async () => {
  const f = fixture();
  f.deps.isChangeBusy = () => false;
  assert.equal((await f.read()).busy, true);
  f.row.change_turn.mode = 'shots';
  assert.equal((await f.read()).busy, false);
});

test('the client uses one checked stop request, with the observed job token', async () => {
  const api = loadTsx('frontend/src/features/agent-session/api.ts');
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return { ok: false, status: 503, json: async () => ({ error: 'Stop failed' }) };
  };
  try {
    await assert.rejects(api.stopTurn(5, { token: 'job', force: true }), /Stop failed/);
    assert.deepEqual(calls, [['/api/agent-sessions/5/stop', { token: 'job', force: true }]]);
  } finally { globalThis.fetch = saved; }
});

test('a fresh screen restores stopping from a server read and offers recovery for a long pending stop', () => {
  const store = loadTsx('frontend/src/features/agent-session/store.ts');
  const turn = store.settleTurn(store.getAgentSessionState().turn, {
    busy: true, sending: false, messages: [],
    turn: { phase: 'cc', stopToken: 'job', stopping: true, stopRequestedAt: Date.now() - 45_000, canForceStop: true },
  });
  assert.equal(turn.running, true);
  assert.equal(turn.stopping, true);
  assert.equal(turn.stopToken, 'job');
  const { StopStatus } = loadTsx('frontend/src/features/agent-session/index.tsx');
  const html = renderToHtml(createElement(StopStatus, { turn, onStop() {} }));
  assert.match(html, /Stopping is taking longer/);
  assert.match(html, /Retry stop/);
  assert.doesNotMatch(html, /Force stop/);
  const ended = store.settleTurn(turn, { busy: false, turn: null, messages: [], sending: false });
  assert.equal(ended.running, false);
  assert.equal(ended.stopping, false);
});
