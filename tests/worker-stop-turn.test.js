// #889: the in-container stop procedure, and why it exists.
//
// The turn runs as a detached `docker exec` wrapper:
//   sh -c 'run-cc.sh > "$TURN_JOURNAL" 2>&1; echo "__USERNODE_EXIT__ $?" >> …'
// The kill walks /proc for anything matching (claude|run-cc.sh) — which
// includes that wrapper shell, since its cmdline contains the run-cc.sh
// path. So the wrapper dies before it can ever write its own exit marker,
// and the host-side journal consumer (a `tail -f` that never exits on its
// own) was left to discover the death via its 10s/2-strike liveness
// watchdog: a measured 18.8s of dead air in production between the click
// and the chat unwinding.
//
// stopTurn therefore writes the marker itself, and these tests pin the
// three properties that make that safe and fast:
//   1. ONE exec, and the order within it: TERM → wait → KILL → marker.
//      Killing before appending is what stops the marker interleaving with
//      a half-written agent line (the wrapper's stdout fd is gone by then).
//   2. The marker goes to the journal the host recorded for THIS turn, with
//      an in-container discovery fallback when the registry doesn't know it.
//   3. Feeding that marker through the real parseLine resolves the watch
//      state the same way a natural exit does.
//
// Run with: node --test tests/worker-stop-turn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// #937: the tests that drive a FULL execInWorker dispatch reach
// mintWorkerJwt, which refuses to run unsecreted. (The gated tests never
// get that far — which is itself the point: the pre-dispatch check sits
// ahead of the JWT mint and the prompt write, so a stop that has already
// landed costs nothing at all.)
process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + logger so no daemon is involved.
// Returns the module plus the recorded `docker.execFileAsync` calls.
//
// #937: `opts.onExec` lets a test react to a recorded call — used to
// simulate a stop landing DURING the dispatch round-trip. `opts.journal`
// installs a fake `child_process.spawn` so _consumeJournal's `tail -f`
// resolves immediately off canned lines instead of shelling out.
function loadWorker({ onExec = null, journalLines = null } = {}) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/worker'),
  };
  if (journalLines) ids.childProcess = require.resolve('child_process');
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const dbCalls = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    execFileAsync: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (onExec) await onExec({ cmd, args, opts });
      return { stdout: '', stderr: '' };
    },
    // execInWorker writes the turn prompt through this one.
    execShellStdin: async () => ({ stdout: '', stderr: '' }),
  });
  const noop = () => {};
  stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });

  // Full dispatches now require the durable lifecycle write to succeed
  // before docker is invoked. Model that contract in memory so these stop
  // race tests continue to exercise the real lifecycle code without a DB.
  const activeTurns = new Map();
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql, params = []) => {
        dbCalls.push({ sql: String(sql), params });
        const text = String(sql);
        const sessionId = Number(params[0]);
        if (/SELECT active_turn FROM chat_sessions/i.test(text)) {
          return { rows: [{ active_turn: activeTurns.get(sessionId) || null }], rowCount: 1 };
        }
        if (/SET active_turn = \$2::jsonb/i.test(text)) {
          if (activeTurns.has(sessionId)) return { rows: [], rowCount: 0 };
          const turn = JSON.parse(params[1]);
          activeTurns.set(sessionId, turn);
          return { rows: [{ active_turn: turn }], rowCount: 1 };
        }
        if (/SET active_turn = active_turn \|\| \$3::jsonb/i.test(text)) {
          const current = activeTurns.get(sessionId);
          if (!current) return { rows: [], rowCount: 0 };
          const next = { ...current, ...JSON.parse(params[2]) };
          activeTurns.set(sessionId, next);
          return { rows: [{ active_turn: next }], rowCount: 1 };
        }
        if (/SET active_turn = NULL/i.test(text)) {
          if (!activeTurns.has(sessionId)) return { rows: [], rowCount: 0 };
          activeTurns.delete(sessionId);
          return { rows: [{ id: sessionId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  });

  if (journalLines) {
    const realCp = require('child_process');
    stub(ids.childProcess, {
      ...realCp,
      spawn: () => {
        const handlers = {};
        const proc = {
          stdout: { on: (ev, fn) => { if (ev === 'data') handlers.data = fn; } },
          stderr: { on: () => {} },
          on: (ev, fn) => { if (ev === 'close') handlers.close = fn; },
          kill: () => {},
        };
        // Feed the canned journal on the next tick, exactly as a real tail
        // would: the consumer stops the moment it parses the exit marker.
        setImmediate(() => {
          handlers.data?.(Buffer.from(`${journalLines.join('\n')}\n`));
          handlers.close?.(0);
        });
        return proc;
      },
    });
  }

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
    delete require.cache[require.resolve('../src/services/worker')];
  };
  return { worker, calls, dbCalls, restore };
}

// A warm worker execInWorker will accept a dispatch for.
function warmSession(worker, sessionId) {
  worker.adoptWarmWorker(sessionId, `usernode-worker-${sessionId}`);
}

const DISPATCH_ARGS = {
  mode: 'build',
  prompt: 'do the thing',
  systemPrompt: 'authoritative platform conventions',
  model: 'claude-opus-5',
  commitMsg: 'wip',
  branchName: 'dev/test',
};

const isDispatch = (c) => c.args?.[0] === 'exec' && c.args?.[1] === '-d';
const isStopScript = (c) => typeof c.args?.[4] === 'string'
  && c.args[4].includes('__USERNODE_EXIT__ 143');

// ── The script the stop runs inside the container ───────────────────────

test('stop script: TERMs, waits, KILLs, then appends the exit marker', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/home/node/.claude/turn-123.log');

    const term = script.indexOf('kill -TERM');
    const wait = script.indexOf('sleep 0.1');
    const kill = script.indexOf('kill -KILL');
    const marker = script.indexOf('__USERNODE_EXIT__ 143');

    assert.ok(term >= 0, 'sends SIGTERM');
    assert.ok(wait > term, 'waits for the SIGTERMed processes after signalling');
    assert.ok(kill > wait, 'escalates to SIGKILL only after the grace window');
    // THE ordering invariant: the marker must be written against a dead
    // turn, or it can interleave with agent output still being flushed.
    assert.ok(marker > kill, 'marker is appended last, after everything is dead');

    // Append, never truncate — a natural exit marker that landed first must
    // survive, and the tail stops at whichever came first either way.
    assert.match(script, /echo "__USERNODE_EXIT__ 143" >> "\$J"/);
    assert.ok(!script.includes('> "$J"\n'), 'never truncates the journal');
    // A stop must never fail loudly; the watchdog is behind it regardless.
    assert.match(script, /exit 0$/);
  } finally { restore(); }
});

test('stop script: targets the recorded journal path, guarded on existence', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/home/node/.claude/turn-999.log');
    assert.match(script, /J='\/home\/node\/\.claude\/turn-999\.log'/);
    assert.match(script, /\[ -f "\$J" \]/, 'no marker if the journal vanished');
    assert.ok(!script.includes('ls -t'), 'no discovery needed when the path is known');
  } finally { restore(); }
});

test('stop script includes the Codex request adapter in every signal and liveness check', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/home/node/.claude/turn-123.log');
    const patterns = [...script.matchAll(/grep -qE '([^']+)'/g)].map(match => new RegExp(match[1]));
    assert.ok(patterns.length >= 3, 'TERM, liveness and KILL all match the same processes');
    for (const pattern of patterns) {
      assert.match('node /usr/local/bin/codex-openrouter-request.js exec --json', pattern);
      assert.match('codex exec --json', pattern);
      assert.doesNotMatch('tail -f /home/node/.claude/turn-codex-openrouter-request.js.log', pattern);
    }
  } finally { restore(); }
});

test('stop script: discovers the journal in-container when the path is unknown', () => {
  const { worker, restore } = loadWorker();
  try {
    // An adopted worker after a platform restart has no registry journal.
    // The dispatch wrapper rm's stale journals first, so newest-wins is
    // unambiguous.
    const script = worker.buildTurnStopScript(null);
    assert.match(script, /J=\$\(ls -t \/home\/node\/\.claude\/turn-\*\.log 2>\/dev\/null \| head -1\)/);
    assert.match(script, /__USERNODE_EXIT__ 143/);
  } finally { restore(); }
});

// ── stopTurn's exec ─────────────────────────────────────────────────────

test('stopTurn issues exactly one docker exec carrying the stop script', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    await worker.stopTurn(4242);

    assert.equal(calls.length, 1, 'one exec — a stop is latency-critical');
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, 'docker');
    assert.equal(args[0], 'exec');
    assert.equal(args[1], 'usernode-worker-4242');
    assert.deepEqual(args.slice(2, 4), ['sh', '-c']);
    assert.match(args[4], /kill -TERM/);
    assert.match(args[4], /__USERNODE_EXIT__ 143/);
    // Must outlast the in-container SIGTERM grace, or the exec is cut off
    // before the marker is written and we're back to the 19s watchdog.
    assert.ok(opts.timeout >= 8000, `timeout ${opts.timeout} covers the kill grace`);
  } finally { restore(); }
});

test('stopTurn flags the session so the watchdog tightens its cadence', async () => {
  const { worker, restore } = loadWorker();
  try {
    const before = worker.warmRegistrySnapshot().find((e) => e.sessionId === 777);
    assert.ok(!before?.stopRequestedAt, 'precondition: no stop pending');

    await worker.stopTurn(777);

    const entry = worker.warmRegistrySnapshot().find((e) => e.sessionId === 777);
    assert.ok(entry, 'stopTurn registers the session');
    assert.ok(entry.stopRequestedAt > 0, 'stamped so _consumeJournal can read it');
  } finally { restore(); }
});

test('stopTurn swallows docker failures — the watchdog is the fallback', async () => {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  try {
    stub(ids.docker, {
      ...require('../src/services/docker'),
      execFileAsync: async () => { throw new Error('daemon unreachable'); },
    });
    const noop = () => {};
    stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });
    delete require.cache[ids.subject];
    const worker = require('../src/services/worker');

    await worker.stopTurn(5150); // must not throw

    // The flag is still set, so the 1s/1-strike watchdog bounds the wait
    // even though the marker never got written.
    const entry = worker.warmRegistrySnapshot().find((e) => e.sessionId === 5150);
    assert.ok(entry.stopRequestedAt > 0);
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
  }
});

// ── The marker, once the consumer reads it ──────────────────────────────

test('the appended marker resolves the watch state like a natural exit', () => {
  const worker = require('../src/services/worker');
  const state = worker.newWatchState();
  assert.equal(state.execExitSeen, false);

  worker.parseLine('__USERNODE_EXIT__ 143', () => {}, state);

  assert.equal(state.execExitSeen, true, 'consumer stops tailing immediately');
  assert.equal(state.exitCode, 143, '128 + SIGTERM — what a docker stop would have produced');
  // NOT a markerless turn: describeMarkerlessExit's "the agent was killed"
  // wording must never surface for a deliberate stop.
  assert.equal(state.markerlessCause, null);
});

// ── #937: the pending-stop record survives the dispatch it guards ───────
//
// The defect these pin: `execInWorker` used to write `stopRequestedAt:
// null` in its dispatch upsert, commented as clearing "any flag a previous
// turn left behind". It could not tell a previous turn's leftover from a
// stop requested for THIS turn two seconds ago — so a stop clicked during
// worker spin-up was erased by the very dispatch it was meant to prevent.
// Production session 2974: clicked at 17:46:09, "Claude Code is running…"
// landed at 17:46:14, and the agent ran until 18:03:59.

test('clearPendingStop / getPendingStop round-trip the record', async () => {
  const { worker, restore } = loadWorker();
  try {
    assert.equal(worker.getPendingStop(8001), null, 'nothing pending initially');

    await worker.stopTurn(8001);
    assert.ok(worker.getPendingStop(8001) > 0, 'stopTurn stamps it');

    worker.clearPendingStop(8001);
    assert.equal(worker.getPendingStop(8001), null, 'and only this clears it');
  } finally { restore(); }
});

test('clearPendingStop on an unknown session does not invent a registry entry', () => {
  const { worker, restore } = loadWorker();
  try {
    worker.clearPendingStop(8002);
    const entry = worker.warmRegistrySnapshot().find((e) => e.sessionId === 8002);
    assert.equal(entry, undefined, 'no phantom warm worker');
  } finally { restore(); }
});

test('a pending stop makes execInWorker skip the dispatch entirely', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    warmSession(worker, 8100);
    await worker.stopTurn(8100);
    const afterStop = calls.length;

    const state = await worker.execInWorker(8100, {
      ...DISPATCH_ARGS,
      agentBackend: 'codex_openrouter',
      logicalTurnId: 'registered-stop-turn-8100',
    });

    // THE assertion: no agent was started. Before this fix the exec ran
    // and the user paid for the whole run they had just cancelled.
    assert.ok(
      !calls.slice(afterStop).some(isDispatch),
      'no `docker exec -d` — the agent must never start'
    );
    // The prompt file isn't even written: the gate is ahead of that work.
    assert.equal(calls.length, afterStop, 'no dispatch-side work at all');

    // And it hands back the shape a genuinely killed turn produces, so the
    // caller's stopped branch and the tail behave identically either way.
    assert.equal(state.execExitSeen, true);
    assert.equal(state.exitCode, 143, '128 + SIGTERM, as a real kill produces');
    assert.equal(state.markerlessCause, null, 'a stop is not a markerless death');
    assert.equal(state.sha, null);
    assert.equal(state.ahead, 0);
    assert.equal(state.turnId, 'registered-stop-turn-8100',
      'the atomically registered owner survives the pre-dispatch stop');
    assert.equal(state.agentBackend, 'codex_openrouter');
  } finally { restore(); }
});

test('a skipped legacy dispatch does not invent a durable turn owner', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    warmSession(worker, 8103);
    await worker.stopTurn(8103);
    const afterStop = calls.length;

    const state = await worker.execInWorker(8103, DISPATCH_ARGS);

    assert.equal(calls.length, afterStop, 'the pending stop still prevents every dispatch-side write');
    assert.equal(state.turnId, null,
      'a generated fallback id is not exposed when no active_turn was registered');
    assert.equal(state.agentBackend, 'claude_code');
  } finally { restore(); }
});

test('a recovered turn mirrors new BYOK spend onto its exact durable owner', async () => {
  const { worker, dbCalls, restore } = loadWorker({
    journalLines: ['__USERNODE_PHASE__thinking', '__USERNODE_EXIT__ 0'],
  });
  try {
    warmSession(worker, 8102);
    const turnId = '22222222-2222-4222-8222-222222222222';
    await worker.resumeTurnFromJournal(8102, {
      journal: '/home/node/.claude/turn-recovered.log',
      turnId,
      onProgress: () => worker.noteTurnByokSpend(8102, 7),
    });
    // noteTurnByokSpend deliberately mirrors asynchronously.
    await new Promise((resolve) => setImmediate(resolve));

    const mirror = dbCalls.find((call) => call.sql.includes("'{byokCents}'"));
    assert.ok(mirror, 'proxy-observed spend reaches the durable lifecycle update');
    assert.equal(mirror.params[0], 7);
    assert.equal(mirror.params[1], 8102);
    assert.equal(mirror.params[2], turnId, 'never mutates whichever turn happens to be current');
  } finally { restore(); }
});

test('the skipped dispatch leaves the pending stop standing', async () => {
  const { worker, restore } = loadWorker();
  try {
    warmSession(worker, 8101);
    await worker.stopTurn(8101);
    const stampedAt = worker.getPendingStop(8101);

    await worker.execInWorker(8101, DISPATCH_ARGS);

    // The record must outlive the turn it stopped: the caller's post-run
    // stopped-check still reads it, and a second dispatch attempt in the
    // same turn must be refused too.
    assert.equal(worker.getPendingStop(8101), stampedAt, 'untouched');
    assert.equal(worker.warmRegistrySnapshot().find((e) => e.sessionId === 8101).inFlight,
      false, 'and no in-flight turn was registered');
  } finally { restore(); }
});

test('a stop landing DURING the dispatch re-issues the kill', async () => {
  // The residual race the pre-dispatch gate cannot close: the stop arrives
  // in the milliseconds while `docker exec -d` is in flight, so its kill
  // found no turn process. The re-arm fires once the registry knows this
  // turn's journal path, which is what makes the marker land.
  let worker;
  const { calls, restore, worker: w } = loadWorker({
    journalLines: ['__USERNODE_EXIT__ 143'],
    onExec: async ({ args }) => {
      // Simulate the click landing between `exec -d` being issued and it
      // returning — stamp the record the way POST /stop would.
      if (args[0] === 'exec' && args[1] === '-d') await worker.stopTurn(8200);
    },
  });
  worker = w;
  try {
    warmSession(worker, 8200);

    await worker.execInWorker(8200, DISPATCH_ARGS);

    const dispatchIdx = calls.findIndex(isDispatch);
    assert.ok(dispatchIdx >= 0, 'this turn really did dispatch');
    const killsAfter = calls.slice(dispatchIdx + 1).filter(isStopScript);
    assert.ok(
      killsAfter.length >= 1,
      'the kill is re-issued once the turn is actually running'
    );
    // The re-issued kill must still carry the full ordered script — the
    // TERM → wait → KILL → marker invariant the tests above pin.
    const script = killsAfter[0].args[4];
    assert.ok(script.indexOf('kill -TERM') < script.indexOf('kill -KILL'));
    assert.ok(script.indexOf('kill -KILL') < script.indexOf('__USERNODE_EXIT__ 143'));
    // Targeted at THIS turn's journal, not a discovery fallback — that is
    // the whole point of re-arming after dispatch rather than before.
    assert.match(script, /J='\/home\/node\/\.claude\/turn-[A-Za-z0-9-]+\.log'/,
      'the kill targets this UUID-safe logical turn journal');
  } finally { restore(); }
});

test('with no stop pending, a dispatch proceeds and issues no kill', async () => {
  const { worker, calls, restore } = loadWorker({
    journalLines: ['__USERNODE_EXIT__ 0'],
  });
  try {
    warmSession(worker, 8300);

    await worker.execInWorker(8300, DISPATCH_ARGS);

    const dispatch = calls.find(isDispatch);
    assert.ok(dispatch, 'the ordinary path still dispatches');
    assert.ok(dispatch.args.includes('COMMIT_MSG=wip'),
      'the requested commit message reaches the runner as non-secret configuration');
    assert.ok(!calls.some(isStopScript), 'and nothing kills a healthy turn');
  } finally { restore(); }
});

test('a hosted Claude build cannot dispatch without authoritative system context', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    warmSession(worker, 8302);

    await assert.rejects(
      () => worker.execInWorker(8302, { ...DISPATCH_ARGS, systemPrompt: null }),
      /hosted Claude build requires systemPrompt/
    );

    assert.equal(calls.length, 0, 'validation fails before either context file or the provider is touched');
  } finally { restore(); }
});

// Every shots turn runs on Claude Code. An OpenRouter evidence
// turn, on either harness, is refused before a token is minted, a context
// file is written, or the provider is touched.
test('a shots turn on an OpenRouter backend is refused before anything is dispatched', async () => {
  const { worker, calls, restore } = loadWorker({ journalLines: ['__USERNODE_EXIT__ 0'] });
  try {
    for (const [sessionId, agentHarness] of [[8304, null], [8305, 'codex'], [8306, 'claude']]) {
      warmSession(worker, sessionId);
      await assert.rejects(
        () => worker.execInWorker(sessionId, {
          mode: 'shots',
          prompt: 'open the run context',
          systemPrompt: 'Shots agent contract.',
          branchName: 'dev/test',
          agentBackend: 'codex_openrouter',
          agentHarness,
          agentModel: 'z-ai/glm-5.3-flash',
          agentModelMetadata: { supportsTools: true },
          openrouterApiKey: 'sk-or-must-not-appear-in-argv',
          shotsRunId: '1'.repeat(32),
          shotsOrigins: { base: 'http://base.test/', head: 'http://head.test/' },
          shotsAuthTokens: { member: 'member', read_only_admin: 'admin', full_admin: 'full-admin' },
        }),
        /execInWorker: shots turns run on Claude Code/,
        String(agentHarness),
      );
    }
    assert.equal(calls.length, 0, 'validation fails before either context file or the provider is touched');
  } finally { restore(); }
});

test('a shots turn refuses a clip size that is not WIDTHxHEIGHT before anything is dispatched', async () => {
  const { worker, calls, restore } = loadWorker({ journalLines: ['__USERNODE_EXIT__ 0'] });
  try {
    warmSession(worker, 8307);
    for (const shotsClipSize of ['390', '390x844 --flag', '0x844', 12]) {
      await assert.rejects(
        () => worker.execInWorker(8307, {
          mode: 'shots',
          prompt: 'open the run context',
          systemPrompt: 'Shots agent contract.',
          branchName: 'dev/test',
          agentBackend: 'claude_code',
          model: 'claude-sonnet-5-5',
          shotsRunId: '1'.repeat(32),
          shotsOrigins: { base: 'http://base.test/', head: 'http://head.test/' },
          shotsAuthTokens: { member: 'member', read_only_admin: 'admin', full_admin: 'full-admin' },
          shotsRecordClips: true,
          shotsClipSize,
        }),
        /execInWorker: shots clip size must be WIDTHxHEIGHT/,
        String(shotsClipSize),
      );
    }
    assert.equal(calls.length, 0);
  } finally { restore(); }
});

test('a complete resume fallback is accepted only for a resumed hosted-Claude build', async () => {
  const { worker, calls, restore } = loadWorker();
  try {
    warmSession(worker, 8303);
    await assert.rejects(
      () => worker.execInWorker(8303, {
        ...DISPATCH_ARGS,
        resumeFallbackPrompt: 'complete prompt with full spec',
      }),
      /resumeFallbackPrompt requires resumeSessionId/,
    );

    warmSession(worker, 8304);
    await assert.rejects(
      () => worker.execInWorker(8304, {
        mode: 'build',
        prompt: 'compact prompt',
        resumeFallbackPrompt: 'complete prompt with full spec',
        resumeSessionId: 'codex-thread',
        branchName: 'dev/openrouter-test',
        agentBackend: 'codex_openrouter',
      }),
      /resumeFallbackPrompt is only supported for Claude turns/,
    );

    assert.equal(calls.length, 0,
      'invalid fallback transport fails before context files or a provider are touched');
  } finally { restore(); }
});

test('Codex dispatch forwards OpenRouter model metadata without exposing its key in argv', async () => {
  const { worker, calls, restore } = loadWorker({
    journalLines: ['__USERNODE_EXIT__ 0'],
  });
  try {
    warmSession(worker, 8301);
    await worker.execInWorker(8301, {
      mode: 'scout',
      prompt: 'inspect the repository',
      branchName: 'dev/openrouter-test',
      agentBackend: 'codex_openrouter',
      agentModel: '~deepseek/deepseek-v4-flash-latest',
      agentReasoningEffort: 'medium',
      agentModelMetadata: {
        name: 'DeepSeek V4 Flash Latest',
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        supportsTools: true,
      },
      openrouterApiKey: 'sk-or-must-not-appear-in-argv',
      openrouterApiBase: 'https://openrouter.ai/api/v1',
    });

    const dispatch = calls.find(isDispatch);
    assert.ok(dispatch, 'Codex turn was dispatched');
    for (const expected of [
      'AGENT_MODEL=~deepseek/deepseek-v4-flash-latest',
      'AGENT_MODEL_NAME=DeepSeek V4 Flash Latest',
      'AGENT_MODEL_CONTEXT_WINDOW=1048576',
      'AGENT_MODEL_MAX_OUTPUT_TOKENS=131072',
      'AGENT_MODEL_SUPPORTS_REASONING=1',
      'AGENT_MODEL_REASONING_EFFORTS=low,medium,high',
      'AGENT_MODEL_SUPPORTS_TOOLS=1',
    ]) {
      assert.ok(dispatch.args.includes(expected), `${expected} reaches the runner`);
    }
    assert.ok(dispatch.args.includes('OPENROUTER_API_KEY'),
      'Docker copies the secret from the host environment by name');
    assert.ok(!dispatch.args.some((arg) => String(arg).includes('sk-or-must-not-appear-in-argv')),
      'the OpenRouter key value never enters docker argv');
  } finally { restore(); }
});


test('immediate Stop kills the process tree without a TERM grace window and confirms before the journal marker', () => {
  const { worker, restore } = loadWorker();
  try {
    const script = worker.buildTurnStopScript('/tmp/turn.log', { force: true });
    assert.doesNotMatch(script, /kill -TERM/);
    assert.ok(script.indexOf('kill -STOP') < script.indexOf('kill -KILL'), 'freeze before collecting descendants');
    assert.match(script, /PPid:/, 'tool subprocesses are included');
    assert.ok(script.indexOf('kill -KILL') < script.indexOf('__USERNODE_EXIT__ 137'));
    assert.ok(script.indexOf('exit 75') < script.indexOf('__USERNODE_EXIT__ 137'), 'a live survivor is an error, never a fake exit');
  } finally { restore(); }
});

test('immediate stop errors reach the caller, and its remote command has a short timeout', async () => {
  const { worker, calls, restore } = loadWorker({ onExec: async () => { throw new Error('runtime unavailable'); } });
  try {
    await assert.rejects(worker.stopTurn(4242, { force: true }), /runtime unavailable/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.timeout, 5000);
    assert.match(calls[0].args[4], /kill -KILL/);
    assert.doesNotMatch(calls[0].args[4], /kill -TERM/);
  } finally { restore(); }
});
