'use strict';

// The agent-session Mayor builds (#2779): a dispatch from the conversation
// onto its active change, the wrap-up after it, the follow-up turn after a
// confirmed card, and history compaction.
//
// Two layers. The turn (services/mayor/agent-turn.js) is driven with a
// scripted model and a stubbed dispatch, to pin what the conversation sees
// and records. The dispatch itself (services/mayor/agent-dispatch.js) is
// driven with stubbed classic tools, to pin that it hands them exactly what
// the classic chat route does and cleans up the change's turn the same way.
//
// Run with: node --test tests/agent-mayor-dispatch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const agentTurn = require('../src/services/mayor/agent-turn');
const dispatch = require('../src/services/mayor/agent-dispatch');
const compaction = require('../src/services/mayor/agent-compaction');
const actions = require('../src/services/agent-session-actions');
const audiences = require('../src/services/mcp-audiences');
const tools = require('../src/services/mayor/tools');

const USER = { id: 7, username: 'ada' };
const CONFIG = { dataEncryptionKey: 'test-only-data-key', port: 3000 };

function recordingPool(handlers = {}) {
  const calls = [];
  let nextId = 100;
  const answer = async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (new RegExp(pattern).test(sql)) return fn(sql, params);
    }
    if (/RETURNING id/.test(sql)) { nextId += 1; return { rows: [{ id: nextId }], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query: answer };
}

function fakeRes() {
  const frames = [];
  return {
    frames,
    write(chunk) { frames.push(chunk); },
    end() {},
    events() { return frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6))); },
  };
}

function scriptedModel(steps) {
  const requests = [];
  return {
    requests,
    async streamChat(args) {
      requests.push(args);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (typeof step === 'function') return step(args);
      if (step.text && args.onToken) args.onToken(step.text);
      return {
        text: step.text || '',
        toolUses: step.toolUses || [],
        rawContent: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...(step.toolUses || []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
}

function fakeShim() {
  return {
    toolNames: [...audiences.AGENT_MAYOR_TOOLS],
    modelTools: audiences.AGENT_MAYOR_TOOLS.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
    async call(name) { return { isError: false, text: `{"tool":"${name}"}` }; },
    async close() {},
  };
}

const SESSION = {
  id: 5, status: 'open', title: 'Dark mode',
  focusApp: { id: 3, slug: 'recipe-box', name: 'Recipe box' }, focusContext: {},
  activeChange: { id: 50, appSlug: 'recipe-box', title: 'Dark mode', status: 'active', prNumber: null },
  changes: [],
};

const CHANGE_ROW = {
  id: 50, user_id: 7, app_id: 3, status: 'active', app_slug: 'recipe-box', app_name: 'Recipe box',
  repo_url: 'https://github.com/example/recipe-box', agent_backend: 'claude_code', agent_model: null,
};

// A dispatch stub: offered when `dispatchable`, recording what it was asked
// to run, answering with `outcome`.
function dispatchStub({ dispatchable = true, outcome = null, onRun = null } = {}) {
  const runs = [];
  const finished = [];
  return {
    runs,
    finished,
    module: {
      ...dispatch,
      loadActiveChange: async () => (dispatchable ? CHANGE_ROW : null),
      canDispatch: () => dispatchable,
      runDispatch: async (args) => {
        runs.push(args);
        if (onRun) await onRun(args);
        const base = outcome || {
          ran: true, changeId: 50, kind: args.kind, isError: false, stopped: false,
          toolResultText: args.kind === 'scout' ? 'Spec v1 written: a toolbar toggle.' : 'Built and pushed. Preview ready.',
        };
        return { ...base, finish: async (opts) => { finished.push(opts); } };
      },
    },
  };
}

async function runTurn({ steps, stub = dispatchStub(), message = 'Add dark mode', followUp = null, pool = recordingPool(), extra = {}, res = fakeRes() }) {
  const model = scriptedModel(steps);
  const spend = [];
  const events = [];
  const deps = {
    llm: { estimateCostCents: () => 4, isEnabled: () => true },
    limits: {
      recordSpend: async (...args) => { spend.push(args); },
      resolveBillingPath: async () => ({ apiKey: null }),
      checkBudget: async () => ({}),
    },
    openMayorMcp: async () => fakeShim(),
    agentSessions: {
      getAgentSession: async () => SESSION,
      appendConversationEvent: async (_pool, event) => { events.push(event); },
      releaseTurnLease: async () => {},
      renewTurnLease: async () => true,
    },
    actions,
    sessionBus: { publish() {}, clearSession() {} },
    dispatch: stub.module,
    debugAccess: { isEligible: async () => false },
    dataTools: { resolveWebFetchToolResult: async () => '{}' },
    ...extra,
  };
  await agentTurn.runAgentTurn({
    pool, config: CONFIG, user: USER, agentSessionId: 5, turnId: 'turn-0002-bbbb',
    messageText: followUp ? null : message, followUp,
    mayor: { ok: true, provider: 'anthropic', client: model, model: 'claude-opus-5-5', apiKey: null, spendRecorded: true, byok: false },
    res, deps,
  });
  return { model, res, pool, spend, events, stub };
}

const assistantRows = (pool) => pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql) && /'assistant'/.test(c.sql));

// ── The turn ───────────────────────────────────────────────────────────

test('a dispatch runs on the active change, then the Mayor wraps up from its result', async () => {
  const { model, res, pool, spend, stub } = await runTurn({
    steps: [
      { text: 'I will write a short spec first.', toolUses: [{ id: 'd1', name: 'dispatch_scout', input: { prompt: 'Spec a toolbar toggle' } }] },
      { text: 'The spec is in: a toggle in the toolbar.', toolUses: [{ id: 'r1', name: 'suggest_replies', input: { replies: ['Build it', 'Change the spec'] } }] },
    ],
  });
  assert.equal(stub.runs.length, 1);
  assert.equal(stub.runs[0].kind, 'scout');
  assert.equal(stub.runs[0].prompt, 'Spec a toolbar toggle');
  assert.equal(stub.runs[0].userMessage, 'Add dark mode');

  // Both dispatch tools were offered, because the active change could take one.
  const offered = model.requests[0].tools.map((t) => t.name);
  assert.ok(offered.includes('dispatch_scout') && offered.includes('dispatch_coding_agent'));
  assert.ok(!offered.includes('dispatch_claude_code'), 'the classic name is not the conversation\'s');

  // The wrap-up saw the dispatch's result against the call, may only suggest
  // replies, and cannot be aborted.
  const wrap = model.requests[1];
  const last = wrap.messages.at(-1);
  assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'd1', content: 'Spec v1 written: a toolbar toggle.' }]);
  assert.deepEqual(wrap.tools.map((t) => t.name), ['suggest_replies']);
  assert.equal(wrap.signal, undefined);
  assert.equal(wrap.telemetryContext.component, 'mayor_phase_2');

  // Two rows: the reply before the dispatch, and the wrap-up on the change.
  const rows = assistantRows(pool);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].params[2], 'I will write a short spec first.');
  assert.equal(JSON.parse(rows[0].params[5]).dispatch, 'scout');
  assert.equal(rows[1].params[0], 50, 'the wrap-up lands on the change\'s slice');
  assert.equal(rows[1].params[2], 'The spec is in: a toggle in the toolbar.');
  const wrapMeta = JSON.parse(rows[1].params[5]);
  assert.equal(wrapMeta.wrapUp, true);
  assert.deepEqual(wrapMeta.quickReplies, ['Build it', 'Change the spec']);

  // The change's turn is released only after the wrap-up row exists.
  assert.deepEqual(stub.finished, [{ wrapUpPosted: true }]);

  const types = res.events().filter((e) => e.type !== 'token').map((e) => (e.type === 'phase' ? `phase:${e.phase}` : e.type));
  assert.deepEqual(types, [
    'phase:mayor', 'mayor_reasoning', 'phase:cc', 'tool', 'tool', 'phase:mayor2',
    'mayor_reasoning', 'quick_replies', 'usage', 'done',
  ]);
  assert.deepEqual(spend.map((s) => s[2]), [4, 4], 'each Mayor call is billed as it happens');
});

test('the owner\'s lists hear when a turn starts and ends, and the end stamps "finished"', async () => {
  const pushed = [];
  const released = [];
  await runTurn({
    steps: [{ text: 'Hello.' }],
    extra: {
      notifyUser: (userId, payload) => { pushed.push([userId, payload]); },
      agentSessions: {
        getAgentSession: async () => SESSION,
        appendConversationEvent: async () => {},
        releaseTurnLease: async (_pool, args) => { released.push(args); pushed.push(['released']); },
        renewTurnLease: async () => true,
      },
    },
  });
  assert.deepEqual(pushed, [
    [USER.id, { type: 'agent_session_changed', agentSessionId: 5, busy: true }],
    ['released'],
    [USER.id, { type: 'agent_session_changed', agentSessionId: 5, busy: false }],
  ], 'working when it starts; finished only once the lease is back, so a re-read sees it');
  assert.deepEqual(released, [{ agentSessionId: 5, turnId: 'turn-0002-bbbb', finished: true }]);

  // A push that throws never costs the turn.
  const { model } = await runTurn({ steps: [{ text: 'Still here.' }], extra: { notifyUser: () => { throw new Error('socket down'); } } });
  assert.equal(model.requests.length, 1, "the turn ran to its answer");
});

test('a run that finishes while nobody is watching lands in the bell, once per change', async () => {
  const steps = [
    { text: 'Building it.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Add the toggle' } }] },
    { text: 'Built.' },
  ];
  // The user left: this turn's stream is closed and nobody follows the events.
  const notified = [];
  const left = fakeRes();
  left.destroyed = true;
  await runTurn({ steps, res: left, extra: { notifyDone: async (_pool, changeId) => { notified.push(changeId); } } });
  assert.deepEqual(notified, [50], 'the dev chat\'s own "Session finished", on the change the run was on');

  // Still watching, through the turn's stream or the conversation's events.
  const watched = [];
  await runTurn({ steps, extra: { notifyDone: async (_pool, id) => { watched.push(id); } } });
  const followed = fakeRes();
  followed.destroyed = true;
  await runTurn({
    steps,
    res: followed,
    extra: {
      notifyDone: async (_pool, id) => { watched.push(id); },
      sessionBus: { publish() {}, clearSession() {}, subscriberCount: () => 1 },
    },
  });
  assert.deepEqual(watched, [], 'nobody is told what they are looking at');

  // A stopped run is the user's own doing, and says nothing.
  const stopped = [];
  await runTurn({
    steps,
    res: left,
    stub: dispatchStub({ outcome: { ran: true, changeId: 50, kind: 'build', isError: false, stopped: true, toolResultText: 'stopped' } }),
    extra: { notifyDone: async (_pool, id) => { stopped.push(id); } },
  });
  assert.deepEqual(stopped, []);
});

test('one dispatch per turn; one the change cannot take is refused to the model', async () => {
  const both = await runTurn({
    steps: [
      { toolUses: [
        { id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build it' } },
        { id: 'd2', name: 'dispatch_scout', input: { prompt: 'Spec it' } },
      ] },
      { text: 'Done.' },
    ],
  });
  assert.equal(both.stub.runs.length, 1);
  assert.equal(both.stub.runs[0].kind, 'scout', 'the spec comes first, as in a classic session');
  const results = both.model.requests[1].messages.at(-1).content;
  assert.match(results.find((r) => r.tool_use_id === 'd1').content, /^skipped: only one dispatch/);

  const none = await runTurn({
    stub: dispatchStub({ dispatchable: false }),
    steps: [
      { toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build it' } }] },
      { text: 'There is no change to build on yet.' },
    ],
  });
  assert.ok(!none.model.requests[0].tools.some((t) => dispatch.isDispatchTool(t.name)), 'not offered');
  assert.equal(none.stub.runs.length, 0);
  assert.match(none.model.requests[1].messages.at(-1).content[0].content, /^not_available/);
});

// Conversation 7, change 4952: after the card, the Mayor said "dispatching
// the coding agent to build it now" and called nothing. Its wrap-up after a
// failed dispatch said "Retrying now." with no tool that could retry.
test('a reply that says the coding agent is starting, with no call, gets one round to make it', async () => {
  const { model, stub } = await runTurn({
    steps: [
      { text: 'Change 4952 is open for #9 — dispatching the coding agent to build it now.' },
      { toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build #9' } }] },
      { text: 'Built.' },
    ],
  });
  assert.equal(stub.runs.length, 1);
  const nudge = model.requests[1].messages;
  assert.deepEqual(nudge.at(-2), { role: 'assistant', content: [{ type: 'text', text: 'Change 4952 is open for #9 — dispatching the coding agent to build it now.' }] });
  assert.equal(nudge.at(-1).role, 'user');
  assert.match(nudge.at(-1).content, /did not call dispatch_coding_agent or dispatch_scout, so nothing is running/);
});

test('with no dispatch on offer, the claim is taken back, and only one round is spent on it', async () => {
  const { model, stub } = await runTurn({
    stub: dispatchStub({ dispatchable: false }),
    steps: [{ text: 'Dispatching the coding agent now.' }],
  });
  assert.equal(stub.runs.length, 0);
  assert.equal(model.requests.length, 2, 'the repeated claim is not nudged again');
  assert.match(model.requests[1].messages.at(-1).content, /no dispatch is available on this turn/);

  // A claim made beside a tool call, with an empty closing round, rides on the
  // tool results rather than as an empty assistant message.
  const split = await runTurn({
    stub: dispatchStub({ dispatchable: false }),
    steps: [
      { text: "I'll start the coding agent on it.", toolUses: [{ id: 'r1', name: 'suggest_replies', input: { replies: ['Thanks'] } }] },
      { text: '' },
      { text: 'Nothing has started yet.' },
    ],
  });
  assert.equal(split.model.requests.length, 3);
  const last = split.model.requests[2].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.match(last.content.at(-1).text, /nothing is running/);
});

test('questions, offers and past runs are not claims', () => {
  for (const text of [
    'Want me to start the coding agent on it?',
    'I can dispatch the coding agent whenever you are ready.',
    'The coding agent has finished. The details are above.',
    'Starting point: the header component.',
  ]) assert.equal(agentTurn.claimsDispatch(text), false, text);
  for (const text of [
    'Change 4952 is open for #9 — dispatching the coding agent to build it now.',
    "You're right. Dispatching the coding agent now.",
    "I'll send it to the scout first.",
  ]) assert.equal(agentTurn.claimsDispatch(text), true, text);
});

test('the wrap-up is told it cannot retry or dispatch', async () => {
  const { model } = await runTurn({
    stub: dispatchStub({ outcome: { ran: false, changeId: 50, kind: 'build', isError: true, stopped: false, toolResultText: 'bootstrap_failed: setup stopped' } }),
    steps: [
      { text: 'Building.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] },
      { text: 'The run did not start. Ask me to try again.' },
    ],
  });
  const wrap = model.requests[1];
  assert.ok(wrap.systemPrompt.endsWith(agentTurn.WRAP_UP_NOTE));
  assert.match(agentTurn.WRAP_UP_NOTE, /cannot retry, dispatch or start anything/);
  assert.match(model.requests[0].systemPrompt, /Never say it is starting, running or being retried unless you make that call/);
});

test('a stopped dispatch skips the wrap-up', async () => {
  const stub = dispatchStub({
    outcome: { ran: true, changeId: 50, kind: 'build', isError: false, stopped: true, stoppedBy: 'ada', toolResultText: 'stopped' },
  });
  const { model, pool, res } = await runTurn({
    stub,
    steps: [{ text: 'Building.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] }],
  });
  assert.equal(model.requests.length, 1, 'no wrap-up call');
  assert.equal(assistantRows(pool).length, 1);
  assert.deepEqual(stub.finished, [], 'the stopped dispatch cleaned up after itself');
  assert.ok(res.events().some((e) => e.type === 'stopped' && e.phase === 'cc' && e.by === 'ada'));
});

test('a refused dispatch is explained, and nobody paying means fixed text', async () => {
  const refused = dispatchStub({
    outcome: { ran: false, isError: true, toolResultText: 'busy: the coding agent is already working on this change.' },
  });
  const one = await runTurn({
    stub: refused,
    steps: [
      { toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] },
      { text: 'It is still busy with the last run.' },
    ],
  });
  assert.deepEqual(one.model.requests[1].messages.at(-1).content[0],
    { type: 'tool_result', tool_use_id: 'd1', content: 'busy: the coding agent is already working on this change.', is_error: true });
  assert.equal(assistantRows(one.pool).at(-1).params[2], 'It is still busy with the last run.');

  const broke = await runTurn({
    steps: [{ text: 'Building now.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] }],
    extra: {
      limits: {
        recordSpend: async () => {},
        resolveBillingPath: async () => ({ error: 'budget exhausted' }),
        checkBudget: async () => ({}),
      },
    },
  });
  assert.equal(broke.model.requests.length, 1, 'no wrap-up model call without a payer');
  assert.equal(assistantRows(broke.pool).at(-1).params[2], 'The coding agent has finished. The details are above.');
  assert.deepEqual(broke.stub.finished, [{ wrapUpPosted: true }]);
});

test('the change is released even when the wrap-up cannot be written', async () => {
  let inserts = 0;
  const pool = recordingPool({
    "INSERT INTO chat_session_messages[\\s\\S]*'assistant'": () => {
      inserts += 1;
      if (inserts === 2) throw new Error('db down');
      return { rows: [{ id: 200 }] };
    },
  });
  const { stub, events } = await runTurn({
    pool,
    steps: [
      { text: 'Building.', toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] },
      { text: 'Built.' },
    ],
  });
  assert.deepEqual(stub.finished, [{ wrapUpPosted: false }], 'released, and not marked as wrapped up');
  assert.deepEqual(events.map((e) => e.event), ['turn_failed']);
});

test('stop names the change during a dispatch, and cannot stop the wrap-up', async () => {
  const seen = [];
  const stub = dispatchStub({
    onRun: async (args) => {
      args.onStopHandle({ changeId: 50, handle: {} });
      seen.push(agentTurn.stopAgentTurn(5, { by: 'ada' }));
    },
  });
  await runTurn({
    stub,
    steps: [
      { toolUses: [{ id: 'd1', name: 'dispatch_coding_agent', input: { prompt: 'Build' } }] },
      async () => {
        seen.push(agentTurn.stopAgentTurn(5, { by: 'ada' }));
        return { text: 'Built.', toolUses: [], rawContent: [{ type: 'text', text: 'Built.' }] };
      },
    ],
  });
  assert.deepEqual(seen, [
    { stopped: false, reason: 'dispatch_running', changeId: 50 },
    { stopped: false, reason: 'wrap_up_not_stoppable' },
  ]);
});

test('a follow-up turn records no user message and carries on from the card', async () => {
  const pool = recordingPool({
    'FROM chat_session_messages': () => ({ rows: [
      { id: 1, session_id: null, role: 'user', content: 'Add dark mode', metadata: {} },
      { id: 2, session_id: null, role: 'assistant', content: 'Confirm the card to start it.', metadata: {} },
      { id: 3, session_id: null, role: 'system', content: 'Confirmed: Start a change. Change 50 is open.', metadata: { agentSessionEvent: 'action_result' } },
    ].reverse() }),
  });
  const { model, stub } = await runTurn({
    pool,
    followUp: { toolName: 'start_change', title: 'Start a change', ok: true },
    steps: [
      { text: 'It is started. Writing the spec now.', toolUses: [{ id: 'd1', name: 'dispatch_scout', input: { prompt: 'Spec it' } }] },
      { text: 'Spec ready.' },
    ],
  });
  assert.ok(!pool.calls.some((c) => /VALUES \(\$1, \$2, 'user'/.test(c.sql)), 'nothing is recorded for the user');
  const first = model.requests[0].messages;
  assert.equal(first.at(-1).role, 'user');
  assert.match(first.at(-1).content, /The user pressed Confirm on "Start a change", and it went through\. Carry on/);
  assert.match(first.at(-2).content, /\[HOMEROOM\] Confirmed: Start a change/);
  assert.equal(stub.runs[0].userMessage, 'Add dark mode', 'the dispatch is briefed with what the user asked');
});

test('the turn keeps its lease fresh while it runs', async () => {
  // Every 15 seconds inside a 90-second window: a deploy that kills the turn
  // leaves its conversation looking busy for at most a minute and a half.
  assert.equal(agentTurn.LEASE_RENEW_MS, 15000);
  assert.ok(agentTurn.LEASE_RENEW_MS < require('../src/services/agent-sessions').TURN_LEASE_STALE_SECONDS * 1000 / 5,
    'renewed many times inside the stale window');
});

// ── Compaction ─────────────────────────────────────────────────────────

function rowsOf(turns, { chars = 1000 } = {}) {
  const rows = [];
  let id = 0;
  for (let i = 0; i < turns; i += 1) {
    rows.push({ id: ++id, role: 'user', content: `ask ${i} ${'x'.repeat(chars)}`, metadata: {} });
    rows.push({ id: ++id, role: 'assistant', content: `answer ${i} ${'y'.repeat(chars)}`, metadata: {} });
  }
  return rows;
}

test('compaction starts past the budget and never takes the last ten turns', () => {
  assert.equal(compaction.planCompaction(rowsOf(30, { chars: 100 })), null, 'under the budget');
  assert.equal(compaction.planCompaction(rowsOf(10, { chars: 20000 })), null, 'over it, but only ten turns');

  const rows = rowsOf(40, { chars: 4000 });
  assert.ok(compaction.estimateTokens(rows) > compaction.COMPACT_AT_TOKENS);
  const plan = compaction.planCompaction(rows);
  assert.equal(plan.rows.length, 60, 'thirty turns fold away');
  assert.equal(plan.throughId, 60);
  const kept = rows.filter((r) => r.id > plan.throughId);
  assert.equal(kept.filter((r) => r.role === 'user').length, compaction.KEEP_TURNS);
  assert.equal(kept[0].role, 'user', 'the kept part starts on a turn boundary');
});

test('a compaction writes forward only, and frames the transcript as data', async () => {
  const pool = recordingPool({ 'UPDATE agent_sessions SET summary_md': () => ({ rowCount: 1 }) });
  const requests = [];
  const mayor = {
    model: 'claude-opus-5-5',
    apiKey: null,
    client: { async streamChat(args) { requests.push(args); return { text: 'Change 50 on recipe-box: dark mode, built.', usage: {} }; } },
  };
  const plan = compaction.planCompaction(rowsOf(40, { chars: 4000 }));
  const cents = await compaction.compact({
    pool, agentSessionId: 5, mayor, previousSummary: 'Earlier: nothing much.', plan, costOf: () => 2,
  });
  assert.equal(cents, 2);
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests[0].telemetryContext.component, 'mayor_compaction');
  assert.match(requests[0].messages[0].content, /^EARLIER SUMMARY:\nEarlier: nothing much\./);
  assert.match(requests[0].messages[0].content, /<untrusted-content>User: ask 0/);
  const update = pool.calls.find((c) => /UPDATE agent_sessions SET summary_md/.test(c.sql));
  assert.match(update.sql, /summary_through_id IS NULL OR summary_through_id < \$3/);
  assert.deepEqual(update.params, [5, 'Change 50 on recipe-box: dark mode, built.', 60]);
});

test('a long conversation is compacted after the turn, and replays only what follows the summary', async () => {
  const long = rowsOf(40, { chars: 4000 });
  const compacted = [];
  const pool = recordingPool({
    'SELECT summary_md, summary_through_id': () => ({ rows: [{ summary_md: 'Earlier notes.', summary_through_id: 12 }] }),
    'FROM chat_session_messages': (_sql, params) => {
      assert.equal(params[2], 12, 'rows after the summary only');
      return { rows: [...long].reverse() };
    },
  });
  const { model } = await runTurn({
    pool,
    stub: dispatchStub({ dispatchable: false }),
    steps: [{ text: 'Here is where things stand.' }],
    extra: {
      compaction: {
        ...compaction,
        compact: async (args) => { compacted.push(args); return 3; },
      },
    },
  });
  assert.match(model.requests[0].systemPrompt, /EARLIER IN THIS CONVERSATION[\s\S]*Earlier notes\./);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].previousSummary, 'Earlier notes.');
  assert.equal(compacted[0].plan.throughId, 60);
});

// ── The dispatch ───────────────────────────────────────────────────────

function dispatchDeps({
  change = CHANGE_ROW, busy = false, tool = null, cleared = true, choice = null, switched = { ok: true },
  // What holds a busy change: a turn, or only a shots run.
  shotsRun = null, shotsWaitMs = undefined,
} = {}) {
  const isBusy = typeof busy === 'function' ? busy : () => busy;
  const log = [];
  const registry = new Map();
  const deps = {
    log,
    registry,
    agentSessions: { getAgentChoice: async () => choice },
    turnDeps: {
      switchSessionAgent: async (_pool, args) => { log.push(['switch', args]); return switched; },
      runScoutTool: async (args) => { log.push(['scout', args]); return tool ? tool(args) : { toolResultText: 'spec', turnId: 't-1' }; },
      runClaudeCodeTool: async (args) => { log.push(['build', args]); return tool ? tool(args) : { toolResultText: 'built', turnId: 't-1', stagingUrl: 'https://s' }; },
      scheduleRetainedInteractiveTurn: async (args) => { log.push(['retain', args]); return true; },
    },
    worker: {
      clearPendingStop: (id) => log.push(['clearPendingStop', id]),
      noteTailMilestone: async (id, milestones, opts) => { log.push(['milestone', id, milestones, opts]); },
      finishTurn: async (id, opts) => { log.push(['finishTurn', id, opts]); return cleared; },
    },
    activeWorkers: {
      isSessionBusy: () => isBusy(),
      hasSessionOperation: () => isBusy() && !shotsRun,
      activeWorkers: new Map(),
      beginSessionOperation: (id) => { log.push(['begin', id]); return () => log.push(['release', id]); },
    },
    shotsRunFor: () => shotsRun,
    shotsWaitMs,
    stopRegistry: {
      createHandle: ({ sessionId, phase, send }) => ({ sessionId, phase, send, stopped: false, stoppedBy: null, abort: new AbortController() }),
      set: (id, handle) => registry.set(id, handle),
      deleteIf: (id, handle) => { if (registry.get(id) === handle) registry.delete(id); },
    },
    sessionBus: { publish: (key, event) => log.push(['bus', key, event.type]) },
    broadcastGlobal: (payload) => log.push(['ws', payload.sessionId, payload.event]),
    models: { resolve: (m) => m || 'claude-opus-5-5' },
    mcpOauth: {
      issueDelegatedAccess: async (_pool, args) => { log.push(['grant', args]); return { accessToken: 'svmcd_x', grantId: 'g1' }; },
      revokeDelegation: async (_pool, args) => { log.push(['revoke', args]); return true; },
    },
    callPlatform: async (...args) => { log.push(['call', args.slice(2, 4)]); return { ok: true, status: 200, body: { ok: true } }; },
    loopbackBaseUrl: () => 'http://127.0.0.1:3000',
  };
  const pool = recordingPool({
    'JOIN chat_sessions cs ON cs.id = s.active_change_id': () => ({ rows: change ? [typeof change === 'function' ? change() : change] : [] }),
  });
  return { deps, log, registry, pool };
}

async function dispatchWith(opts = {}, kind = 'build') {
  const { deps, log, registry, pool } = dispatchDeps(opts);
  const agentEvents = [];
  const handles = [];
  const outcome = await dispatch.runDispatch({
    pool, config: CONFIG, user: USER, agentSessionId: 5, kind, prompt: 'Build the toggle', userMessage: 'Add dark mode',
    apiKey: 'sk-byok', sendAgent: (type, data) => agentEvents.push({ type, ...data }),
    res: { write() {} }, onStopHandle: (h) => handles.push(h), shouldStop: opts.shouldStop, scheduleInteractiveRecovery: 'sched', deps,
  });
  return { outcome, log, registry, agentEvents, handles, pool };
}

test('a dispatch hands the classic tool exactly what the chat route does', async () => {
  const { outcome, log, registry, handles } = await dispatchWith();
  const [kind, args] = log.find((entry) => entry[0] === 'build');
  assert.equal(kind, 'build');
  assert.equal(args.session, CHANGE_ROW);
  assert.deepEqual(args.req, { user: USER });
  assert.equal(args.repoOwner, 'example');
  assert.equal(args.repoName, 'recipe-box');
  assert.equal(args.toolPromptArg, 'Build the toggle');
  assert.equal(args.userMessage, 'Add dark mode');
  assert.equal(args.selectedModel, 'claude-opus-5-5');
  assert.equal(args.userApiKey, 'sk-byok');
  assert.equal(args.deferTurnCleanup, true, 'the durable turn outlives the tool until the wrap-up');
  assert.equal(args.stopHandle.phase, 'cc');
  assert.equal(registry.get(50), args.stopHandle, 'the change\'s own stop route can reach it');
  assert.equal(handles[0].changeId, 50);
  assert.deepEqual(log.slice(0, 2), [['begin', 50], ['clearPendingStop', 50]]);
  assert.equal(outcome.toolResultText, 'built');
  assert.equal(outcome.stagingUrl, 'https://s');

  await outcome.finish({ wrapUpPosted: true });
  await outcome.finish({ wrapUpPosted: true });
  const tail = log.filter((e) => ['milestone', 'finishTurn', 'release'].includes(e[0]));
  assert.deepEqual(tail, [
    ['milestone', 50, { wrapUpPosted: true }, { turnId: 't-1' }],
    ['finishTurn', 50, { turnId: 't-1' }],
    ['release', 50],
  ], 'finished once, in the classic order');
  assert.equal(registry.has(50), false);
});

test('a dispatch\'s events reach the conversation and the change, but not its end', async () => {
  const { log, agentEvents } = await dispatchWith({
    tool: async (args) => {
      args.send('cc_progress', { text: 'Editing' });
      await args.sendStatus('Staging deployed!', { stagingUrl: 'https://s' });
      args.send('token', { text: 'x' });
      return { toolResultText: 'built', turnId: 't-1' };
    },
  });
  assert.deepEqual(agentEvents.map((e) => [e.type, e.changeId]), [['cc_progress', 50], ['status', 50], ['token', 50]]);
  assert.deepEqual(log.filter((e) => e[0] === 'ws').map((e) => e.slice(1)), [[50, 'cc_progress'], [50, 'status']],
    'a token never goes on the global socket');
  assert.deepEqual(log.filter((e) => e[0] === 'bus').map((e) => e.slice(1)), [[50, 'cc_progress'], [50, 'status'], [50, 'token']]);
});

test('a parked change is reopened through the resume route first', async () => {
  let reads = 0;
  const { outcome, log } = await dispatchWith({
    // Parked when first read; the (stubbed) resume route reopens it.
    change: () => ({ ...CHANGE_ROW, status: (reads += 1) === 1 ? 'paused' : 'active' }),
    tool: async () => ({ toolResultText: 'built', turnId: 't-1' }),
  });
  assert.equal(outcome.toolResultText, 'built');
  const grant = log.find((e) => e[0] === 'grant');
  assert.deepEqual(
    { kind: grant[1].kind, changeId: grant[1].changeId, appId: grant[1].appId, ttl: grant[1].ttlSeconds },
    { kind: 'agent_mayor', changeId: 50, appId: 3, ttl: 60 }
  );
  assert.deepEqual(log.find((e) => e[0] === 'call')[1], ['POST', '/api/sessions/50/resume']);
  assert.deepEqual(log.find((e) => e[0] === 'revoke')[1], { grantId: 'g1', reason: 'action_done' });
  const order = log.map((e) => e[0]).filter((k) => ['call', 'revoke', 'begin'].includes(k));
  assert.deepEqual(order, ['call', 'revoke', 'begin'], 'reopened and the grant gone before the change is claimed');
});

test('the conversation\'s model applies from the next build: a Claude pick picks the model, a backend or OpenRouter change switches the change first', async () => {
  const onClaude = await dispatchWith({ choice: { backend: 'claude_code', model: 'claude-fable-5-1', reasoningEffort: null } });
  const [, claudeArgs] = onClaude.log.find((e) => e[0] === 'build');
  assert.equal(claudeArgs.selectedModel, 'claude-fable-5-1');
  assert.ok(!onClaude.log.some((e) => e[0] === 'switch'), 'a Claude model is chosen per run, not by a reset');

  let reads = 0;
  const toCodex = await dispatchWith({
    change: () => ((reads += 1) === 1 ? CHANGE_ROW : { ...CHANGE_ROW, agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5' }),
    choice: { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' },
  });
  const [, switchArgs] = toCodex.log.find((e) => e[0] === 'switch');
  assert.deepEqual(switchArgs, {
    sessionId: 50, userId: 7,
    pref: { backend: 'codex_openrouter', provider: 'openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' },
  });
  const order = toCodex.log.map((e) => e[0]).filter((k) => ['switch', 'begin', 'build'].includes(k));
  assert.deepEqual(order, ['switch', 'begin', 'build'], 'switched before the change is claimed (the switch refuses a busy one)');
  const [, codexArgs] = toCodex.log.find((e) => e[0] === 'build');
  assert.equal(codexArgs.session.agent_backend, 'codex_openrouter', 'the build runs on the switched row');

  const refused = await dispatchWith({
    choice: { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: null },
    switched: { ok: false, status: 409, error: 'Session is busy' },
  });
  assert.match(refused.outcome.toolResultText, /model_switch_failed/);
  assert.ok(!refused.log.some((event) => event[0] === 'build'), 'a failed model switch must not run the previous model');

  assert.equal(dispatch.needsAgentSwitch(CHANGE_ROW, null), false, 'no choice follows what the change has');
  assert.equal(dispatch.needsAgentSwitch({ ...CHANGE_ROW, agent_backend: null }, { backend: 'claude_code', model: 'x' }), false);
  const codexChange = { ...CHANGE_ROW, agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5', agent_reasoning_effort: 'low' };
  assert.equal(dispatch.needsAgentSwitch(codexChange, { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'low' }), false);
  assert.equal(dispatch.needsAgentSwitch(codexChange, { backend: 'codex_openrouter', model: 'z-ai/glm-5', reasoningEffort: 'high' }), true);
  assert.equal(dispatch.needsAgentSwitch(codexChange, { backend: 'codex_openrouter', model: 'moonshot/kimi', reasoningEffort: 'low' }), true);
  assert.equal(dispatch.needsAgentSwitch(codexChange, { backend: 'claude_code', model: null }), true);
  assert.deepEqual(dispatch.agentPrefFor({ backend: 'claude_code', model: 'claude-sonnet-5', reasoningEffort: 'high' }),
    { backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null },
    'a Claude change stores no model: each run picks it');
});

test('a dispatch is refused when there is nothing to build on', async () => {
  assert.match((await dispatchWith({ change: null })).outcome.toolResultText, /^no_active_change/);
  assert.match((await dispatchWith({ change: { ...CHANGE_ROW, status: 'merged' } })).outcome.toolResultText, /^change_closed/);
  assert.match((await dispatchWith({ change: { ...CHANGE_ROW, repo_url: null } })).outcome.toolResultText, /^no_repository/);
  const busy = await dispatchWith({ busy: true });
  assert.match(busy.outcome.toolResultText, /^busy/);
  assert.ok(!busy.log.some((e) => e[0] === 'begin'), 'a busy change is not claimed');
  assert.equal(dispatch.canDispatch(null), false);
});

test('a change held only by a shots run waits it out, then builds', async () => {
  let running = true;
  let finish;
  const shotsRun = new Promise((resolve) => { finish = resolve; });
  const { deps } = dispatchDeps({ busy: () => running, shotsRun });
  assert.equal(dispatch.canDispatch(CHANGE_ROW, deps), true, 'the tools stay on offer while evidence records');
  setTimeout(() => { running = false; finish(); }, 5);
  const { outcome, log, agentEvents } = await dispatchWith({ busy: () => running, shotsRun });
  assert.equal(outcome.toolResultText, 'built');
  assert.match(agentEvents[0].text, /^Before & after shots is being recorded/);
  assert.equal(agentEvents[0].changeId, 50);
  assert.deepEqual(log[0], ['begin', 50], 'claimed only after the run ended');
});

test('a shots run that outlasts the wait is refused as what it is, not as the coding agent', async () => {
  const { outcome, log } = await dispatchWith({ busy: true, shotsRun: new Promise(() => {}), shotsWaitMs: 5 });
  assert.match(outcome.toolResultText, /^busy_shots: /);
  assert.match(outcome.toolResultText, /not the coding agent/);
  assert.match(outcome.toolResultText, /nothing will retry it automatically/);
  assert.ok(!log.some((e) => e[0] === 'begin'));

  const turn = dispatchDeps({ busy: true });
  assert.equal(dispatch.canDispatch(CHANGE_ROW, turn.deps), false, 'a turn holding the change still hides the tools');
});

test('a stopped or crashed dispatch leaves the change\'s turn to its recovery', async () => {
  const stopped = await dispatchWith({
    tool: async (args) => { args.stopHandle.stopped = true; args.stopHandle.stoppedBy = 'ada'; return { turnId: 't-9' }; },
  });
  assert.equal(stopped.outcome.stopped, true);
  assert.equal(stopped.outcome.stoppedBy, 'ada');
  assert.deepEqual(stopped.log.filter((e) => ['milestone', 'finishTurn'].includes(e[0])), [['finishTurn', 50, { turnId: 't-9' }]],
    'no wrap-up milestone for a stopped run');

  const uncleared = await dispatchWith({ cleared: false });
  await uncleared.outcome.finish({ wrapUpPosted: true });
  const retained = uncleared.log.find((e) => e[0] === 'retain')[1];
  assert.deepEqual(retained, { pool: uncleared.pool, sessionId: 50, scheduleInteractiveRecovery: 'sched', assumeRetained: true });

  const crashed = await dispatchWith({ tool: async () => { throw new Error('worker gone'); } });
  assert.equal(crashed.outcome.isError, true);
  assert.equal(crashed.log.find((e) => e[0] === 'retain')[1].assumeRetained, undefined);
  assert.ok(crashed.log.some((e) => e[0] === 'release'));
});

test('the dispatch tools say they work on the active change', () => {
  assert.deepEqual(Object.keys(dispatch.DISPATCH_KINDS), ['dispatch_scout', 'dispatch_coding_agent']);
  for (const tool of [dispatch.SCOUT_TOOL, dispatch.BUILD_TOOL]) {
    assert.match(tool.description, /ACTIVE change/);
    assert.deepEqual(tool.input_schema.required, ['prompt']);
    assert.deepEqual(Object.keys(tool.input_schema.properties), ['prompt'],
      'issue links go through update_proposal_issues, which the user confirms');
  }
  assert.equal(tools.SUGGEST_REPLIES_TOOL.name, 'suggest_replies');
});


test('a stop during dispatch preparation never starts a coding tool', async () => {
  for (const stopAt of [1, 2, 3]) {
    let reads = 0;
    const result = await dispatchWith({ shouldStop: async () => ++reads >= stopAt });
    assert.equal(result.outcome.stopped, true);
    assert.equal(result.log.some(([kind]) => kind === 'build' || kind === 'scout'), false);
    if (result.outcome.finish) await result.outcome.finish({});
    assert.equal(result.registry.size, 0);
  }
});


test('a durable cross-process stop notification interrupts the owning turn immediately and ignores stale notifications', async () => {
  let reads = 0;
  const { res } = await runTurn({
    steps: [async () => {
      const id = agentTurn.turnState(5).id;
      const deps = { agentSessions: { readTurnStopRequest: async () => { reads += 1; return { stopRequestedAt: new Date().toISOString(), stopRequestedBy: 'ada' }; } } };
      assert.equal(await agentTurn.receiveStopRequest({}, { agentSessionId: 5, turnId: 'old-turn' }, deps), false);
      assert.equal(reads, 0, 'another turn is not even read');
      assert.equal(await agentTurn.receiveStopRequest({}, { agentSessionId: 5, turnId: id }, { agentSessions: { readTurnStopRequest: async () => null } }), false);
      assert.equal(await agentTurn.receiveStopRequest({}, { agentSessionId: 5, turnId: id }, deps), true);
      assert.equal(agentTurn.turnState(5).stopping, true);
      return { text: '', toolUses: [], rawContent: [], usage: {} };
    }],
  });
  assert.equal(reads, 1);
  assert.ok(res.events().some((event) => event.type === 'stopping'));
});
