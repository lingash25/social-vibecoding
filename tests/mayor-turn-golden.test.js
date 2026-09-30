// Golden parity suite for the Mayor turn (#2779).
//
// POST /api/sessions/:id/chat runs the whole Mayor turn: the phase-1 model
// call and its data-tool loop, the one terminal dispatch (scout or build),
// the phase-2 wrap-up, pills, billing and every persisted row. The agent-
// sessions spec (docs/agent-sessions.md) moves that loop out of the route
// into src/services/mayor/ (turn.js, tools.js, pills.js, replies.js,
// data-tools.js, messages.js, prompt.js) with NO behaviour change. This
// suite is the proof: each scenario drives the real route end to end against
// recording fakes and compares everything observable with a committed golden
// (tests/fixtures/mayor-turn-golden.json):
//
//   - the SSE events the browser receives (_seq normalised);
//   - the global WebSocket broadcasts;
//   - every SQL statement the turn issues, in order, with its parameters;
//   - every model call (system prompt and tool definitions by sha256 so the
//     fixture stays small but byte-exact; messages in full);
//   - billing, worker and title calls.
//
// Refresh the golden only for a deliberate behaviour change, never to make a
// refactor pass:
//
//   UPDATE_GOLDEN=1 node --test tests/mayor-turn-golden.test.js
//
// Harness: property overrides installed BEFORE the route is required (the
// tests/chat-repo-less-turn.test.js pattern), a stateful in-memory pool, a
// scripted model, and a real express app read over fetch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'mayor-turn-golden.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// ── Recording state (reset per scenario) ─────────────────────────────────

let rec = null;
function resetRecording() {
  rec = { queries: [], llm: [], billing: [], worker: [], broadcasts: [], calls: [] };
}
resetRecording();

// ── Stateful pool ────────────────────────────────────────────────────────

let db = null;
function resetDb(session, { history = [] } = {}) {
  db = {
    session: { ...session },
    messages: history.map((m, i) => ({ id: 500 + i, ...m, metadata: m.metadata || {} })),
    nextMessageId: 900,
    specVersions: [],
    effects: new Map(),
    openProposals: [],
  };
}

async function poolQuery(sql, params = []) {
  const s = String(sql);
  rec.queries.push({ sql: s.replace(/\s+/g, ' ').trim(), params: normalizeParams(params) });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim())) return { rows: [], rowCount: 0 };

  if (/INSERT INTO turn_effects/i.test(s)) {
    const key = `${params[0]}:${params[1]}`;
    if (db.effects.has(key)) return { rows: [], rowCount: 0 };
    const effect = { state: 'pending', result: null };
    db.effects.set(key, effect);
    return { rows: [{ state: effect.state }], rowCount: 1 };
  }
  if (/UPDATE turn_effects/i.test(s)) {
    const effect = db.effects.get(`${params[0]}:${params[1]}`);
    if (!effect || effect.state !== 'pending') return { rows: [], rowCount: 0 };
    effect.state = 'completed';
    effect.result = params[2] == null ? null : JSON.parse(params[2]);
    return { rows: [{ result: effect.result }], rowCount: 1 };
  }
  if (/SELECT state(?:, result)? FROM turn_effects/i.test(s)) {
    const effect = db.effects.get(`${params[0]}:${params[1]}`);
    return { rows: effect ? [{ ...effect }] : [], rowCount: effect ? 1 : 0 };
  }

  if (/FROM chat_sessions cs/.test(s) && /status IN \('promoted', 'merging'\)/.test(s)) {
    return { rows: db.openProposals.map((p) => ({ ...p })) };
  }
  if (/FROM chat_sessions cs/.test(s) && /JOIN apps a/.test(s)) {
    return { rows: [{ ...db.session }] };
  }
  if (/SELECT id, role, content, metadata FROM chat_session_messages/.test(s)) {
    const rows = db.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant'
        || (m.role === 'system' && m.metadata && m.metadata.ccOutput != null))
      .map((m) => ({ id: m.id, role: m.role, content: m.content, metadata: m.metadata }));
    return { rows };
  }
  if (/INSERT INTO chat_session_messages/i.test(s)) {
    const role = /'user'/.test(s) ? 'user' : (/'system'/.test(s) ? 'system' : 'assistant');
    const metaIdx = role === 'user' || role === 'system' ? 2 : null;
    let metadata = {};
    const raw = metaIdx != null ? params[metaIdx] : params.find((p) => typeof p === 'string' && p.startsWith('{'));
    try { metadata = raw ? JSON.parse(raw) : {}; } catch { metadata = {}; }
    const row = { id: db.nextMessageId++, role, content: params[1], metadata };
    db.messages.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/SELECT spec_md FROM chat_sessions/i.test(s)) {
    return { rows: [{ spec_md: db.session.spec_md || '' }] };
  }
  if (/UPDATE chat_sessions SET spec_md/i.test(s)) {
    db.session.spec_md = params[0];
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO chat_session_specs/i.test(s)) {
    db.specVersions.push(params[1]);
    return { rows: [{ version: db.specVersions.length }] };
  }
  return { rows: [], rowCount: 0 };
}

const fakePool = {
  query: poolQuery,
  connect: async () => ({ query: poolQuery, release: () => {} }),
};
const poolMod = require('../src/db/pool');
poolMod.getPool = () => fakePool;

// ── Normalisation ────────────────────────────────────────────────────────

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Strings longer than this are pinned by hash + length: still byte-exact,
// but the fixture stays reviewable.
const LONG = 400;
function normalizeValue(v) {
  if (v instanceof Date) return '<date>';
  if (typeof v === 'string') {
    const s = v.replace(UUID_RE, '<uuid>');
    return s.length > LONG ? `<sha:${sha(s)} len:${s.length}>` : s;
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = /(?:At|_at|Ms|durationMs|elapsed)$/.test(k) && typeof val === 'number' ? '<num>' : normalizeValue(val);
    }
    return out;
  }
  return v;
}
function normalizeParams(params) {
  return (params || []).map((p) => {
    if (typeof p === 'string' && (p.startsWith('{') || p.startsWith('['))) {
      try { return { json: normalizeValue(JSON.parse(p)) }; } catch { /* plain */ }
    }
    return normalizeValue(p);
  });
}

// ── Model ────────────────────────────────────────────────────────────────

const llm = require('../src/services/llm');
let llmScript = [];
// The pill ladder's own model calls (rungs 2 and 3) draw from a separate
// queue, so a scenario scripts the Mayor and the ladder independently.
let pillScript = [];
llm.isEnabled = () => true;
llm.estimateCostCents = (usage) => (usage ? ((usage.input_tokens || 0) + (usage.output_tokens || 0)) / 100 : 0);
llm.streamChat = async (args) => {
  rec.llm.push({
    kind: 'streamChat',
    model: args.model,
    apiKey: args.apiKey || null,
    systemPrompt: { sha: sha(args.systemPrompt || ''), length: String(args.systemPrompt || '').length },
    tools: (args.tools || []).map((t) => t.name),
    toolsSha: sha(args.tools || []),
    toolChoice: args.toolChoice || null,
    messages: normalizeValue(args.messages),
    telemetry: args.telemetryContext ? args.telemetryContext.component || null : null,
  });
  const step = llmScript.shift();
  if (!step) throw new Error('golden: unexpected streamChat call');
  if (typeof step === 'function') return step(args);
  if (step.throw) throw Object.assign(new Error(step.throw), step.errorProps || {});
  if (step.text && args.onToken) args.onToken(step.text);
  return JSON.parse(JSON.stringify(step));
};
llm.requireQuickReplies = async (args) => {
  rec.llm.push({ kind: 'requireQuickReplies', model: args.model || null });
  const step = pillScript.shift();
  if (!step) throw new Error('golden: unexpected requireQuickReplies call');
  return JSON.parse(JSON.stringify(step));
};
llm.generateQuickReplies = async (args) => {
  rec.llm.push({ kind: 'generateQuickReplies', model: args.model || null });
  const step = pillScript.shift();
  if (!step) throw new Error('golden: unexpected generateQuickReplies call');
  return JSON.parse(JSON.stringify(step));
};

// ── Billing ──────────────────────────────────────────────────────────────

const limits = require('../src/services/limits');
let billingPath = { apiKey: null };
limits.resolveBillingPath = async (_pool, _key, userId) => { rec.billing.push({ fn: 'resolveBillingPath', userId }); return { ...billingPath }; };
limits.checkBudget = async (_pool, userId) => { rec.billing.push({ fn: 'checkBudget', userId }); return {}; };
limits.recordSpend = async (_pool, userId, cents, opts) => { rec.billing.push({ fn: 'recordSpend', userId, cents, opts: opts || null }); };
limits.settleTurnSpend = async (_pool, userId, cents, opts) => { rec.billing.push({ fn: 'settleTurnSpend', userId, cents, opts: normalizeValue(opts || null) }); return { applied: true }; };

// ── Titles, broadcasts, fire-and-forget work ─────────────────────────────

// Status fan-out has its own suite. Its 150ms coalescer otherwise records
// unrelated SQL here depending on CPU load, sometimes in the NEXT scenario.
// Keep the turn golden deterministic without changing its expected output.
require('../src/services/session-state').touch = () => {};

const sessionTitles = require('../src/services/session-title');
sessionTitles.titleAtTurnEnd = (args) => { rec.calls.push({ fn: 'titleAtTurnEnd', firstTurn: !!args.firstTurn, message: args.message }); };
sessionTitles.titleFromFirstMessage = (args) => { rec.calls.push({ fn: 'titleFromFirstMessage', message: args.message }); };
sessionTitles.maybeTitleFirstMessage = () => {};
sessionTitles.refreshFromHistory = () => {};

const ws = require('../src/services/ws');
ws.broadcastGlobal = (payload) => { rec.broadcasts.push(normalizeEvent(payload)); };
ws.pushIssueUpdate = () => {};
ws.pushSessionUpdate = () => {};
ws.pushNotificationToUser = () => 0;

const webFetch = require('../src/services/web-fetch');
webFetch.fetchUrl = async (url) => ({ ok: true, url, status: 200, contentType: 'text/html', text: `Fetched ${url}: the page says hello.` });

const github = require('../src/services/github');
github.fetchPublicIssues = async () => ({ issues: [{ number: 34, title: 'Dark mode please', labels: [] }], truncated: false });

// ── Worker ───────────────────────────────────────────────────────────────

const worker = require('../src/services/worker');
// Per-scenario: what the coding agent / scout "did". A function receives the
// execInWorker options and returns the worker result.
let workerRun = null;
worker.clearPendingStop = (id) => { rec.worker.push({ fn: 'clearPendingStop', id }); };
worker.ensureWorkerImage = async () => { rec.worker.push({ fn: 'ensureWorkerImage' }); };
worker.ensureWorker = async (id) => { rec.worker.push({ fn: 'ensureWorker', id }); return `usernode-worker-${id}`; };
worker.syncUserAgentFiles = async () => { rec.worker.push({ fn: 'syncUserAgentFiles' }); };
worker.getTurnByokCents = async () => 0;
worker.markTurnRetryPending = async () => { rec.worker.push({ fn: 'markTurnRetryPending' }); };
worker.noteTailMilestone = async (id, milestone, opts) => { rec.worker.push({ fn: 'noteTailMilestone', id, milestone, opts: normalizeValue(opts || null) }); };
worker.finishTurn = async (id, opts) => { rec.worker.push({ fn: 'finishTurn', id, opts: normalizeValue(opts || null) }); return true; };
worker.stopTurn = async (id) => { rec.worker.push({ fn: 'stopTurn', id }); };
worker.evictWorker = async (id) => { rec.worker.push({ fn: 'evictWorker', id }); };
worker.execPushFromWorker = async () => { rec.worker.push({ fn: 'execPushFromWorker' }); return { pushOk: true }; };
worker.execInWorker = async (id, opts) => {
  rec.worker.push({
    fn: 'execInWorker',
    id,
    mode: opts.mode,
    model: opts.model || null,
    branchName: opts.branchName || null,
    resumeSessionId: opts.resumeSessionId || null,
    prompt: { sha: sha(opts.prompt || ''), length: String(opts.prompt || '').length },
    systemPrompt: opts.systemPrompt ? { sha: sha(opts.systemPrompt), length: opts.systemPrompt.length } : null,
    holdTurnRecord: !!opts.holdTurnRecord,
    telemetryComponent: opts.telemetryComponent || null,
  });
  if (!workerRun) throw new Error('golden: unexpected execInWorker call');
  return workerRun(id, opts);
};

// The Codex attempt ledger (OpenRouter coding turns).
const agentTurn = require('../src/services/agent-turn');
agentTurn.resolveCodexRuntimeContext = async () => ({
  agentModel: 'openai/gpt-5.3-codex',
  agentReasoningEffort: 'low',
  resumeThreadId: null,
});
agentTurn.startCodexAttempt = async (args) => {
  rec.calls.push({ fn: 'startCodexAttempt', attemptNumber: args.attemptNumber, mode: args.mode, model: args.model });
  return { turnUuid: `attempt-${args.attemptNumber}`, journal: '/tmp/golden-journal' };
};
agentTurn.completeCodexAttempt = async (args) => {
  rec.calls.push({ fn: 'completeCodexAttempt', turnUuid: args.turnUuid, status: args.status });
  return { estimatedCost: { estimatedCostUsd: 0.12 } };
};

const managedOpenRouter = require('../src/services/openrouter-managed-keys');
managedOpenRouter.usesIncludedKey = async () => false;

// Per-scenario OpenRouter Mayor resolution for codex_openrouter sessions.
const openRouterMayor = require('../src/services/openrouter-mayor');
let openRouterMayorResolution = { error: 'disabled' };
openRouterMayor.resolveForSession = async () => {
  rec.calls.push({ fn: 'openRouterMayor.resolveForSession' });
  if (openRouterMayorResolution.error) return { ...openRouterMayorResolution };
  return {
    client: { streamChat: llm.streamChat, estimateCostCents: llm.estimateCostCents, isEnabled: () => true },
    model: 'openai/gpt-5.3-codex',
    modelLabel: 'openai/gpt-5.3-codex',
    usesIncludedKey: !!openRouterMayorResolution.usesIncludedKey,
  };
};

const localAgent = require('../src/services/local-agent');
localAgent.activeLease = async () => null;

const staging = require('../src/services/staging');
staging.buildAndDeployStaging = async (_config, session, _app, sha1) => {
  rec.calls.push({ fn: 'buildAndDeployStaging', sessionId: session.id, sha: sha1 });
  return { containerId: 'stage-1', stagingUrl: 'https://whiteboard-pr42.staging.test', hostname: 'whiteboard-pr42.staging.test' };
};
staging.verifyStagingEdge = async () => { rec.calls.push({ fn: 'verifyStagingEdge' }); };

const visuals = require('../src/services/visuals');
visuals.setChecksPending = async (_pool, id) => { rec.calls.push({ fn: 'setChecksPending', id }); };
visuals.captureForSession = async (_pool, id) => { rec.calls.push({ fn: 'captureForSession', id }); };

const prMetadata = require('../src/services/pr-metadata');
prMetadata.applyPrMetadata = async (args) => {
  rec.calls.push({ fn: 'applyPrMetadata', userMessage: args.userMessage, ccSummary: args.ccSummary, proposalDescription: args.proposalDescription || null });
  if (!args.session.pr_number) {
    args.session.pr_number = 42;
    args.session.pr_title = 'Add a dark mode toggle';
    args.session.pr_url = 'https://github.com/usernode-bot/whiteboard-0d337f/pull/42';
  }
  return { prNumber: args.session.pr_number, prUrl: args.session.pr_url };
};

// ── The route ────────────────────────────────────────────────────────────

const stopRegistry = require('../src/services/stop-registry');
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };
const BASE_SESSION = {
  id: 4242,
  app_id: 31,
  user_id: 7,
  branch_name: 'dev/tester-4242',
  status: 'active',
  is_headless: false,
  source: null,
  session_title: 'Dark mode',
  pr_number: null,
  pr_title: null,
  cc_session_id: null,
  cloned_from_session_id: null,
  agent_backend: 'claude_code',
  agent_model: null,
  spec_md: '',
  linked_issues: [],
  app_slug: 'whiteboard-0d337f',
  app_name: 'Whiteboard',
  repo_url: 'https://github.com/usernode-bot/whiteboard-0d337f',
  app_self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
};

function normalizeEvent(e) {
  const out = normalizeValue(e);
  if (out && typeof out._seq === 'string') out._seq = out._seq.replace(/^[0-9a-z]+-/, '#');
  return out;
}

function parseSse(body) {
  return body.split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => normalizeEvent(JSON.parse(chunk.slice('data: '.length))));
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

async function runTurn({ session = {}, history = [], message = 'Add a dark mode toggle', llmSteps = [], pillSteps = [], openProposals = [], billing = { apiKey: null }, run = null, openRouterMayor: orMayor = { error: 'disabled' } } = {}) {
  resetRecording();
  resetDb({ ...BASE_SESSION, ...session }, { history });
  db.openProposals = openProposals;
  llmScript = [...llmSteps];
  pillScript = [...pillSteps];
  billingPath = billing;
  workerRun = run;
  openRouterMayorResolution = orMayor;
  stopRegistry._reset?.();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({ jwtSecret: 'golden', dataEncryptionKey: 'golden-key' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${BASE_SESSION.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const status = res.status;
    const events = parseSse(await res.text());
    await settle();
    // One line per entry: compact, and a golden diff reads as a list.
    const line = (v) => JSON.stringify(v);
    const shortSql = (sql) => (sql.length > 160 ? `${sql.slice(0, 120)}… <sha:${sha(sql)} len:${sql.length}>` : sql);
    return {
      status,
      events: events.map(line),
      broadcasts: rec.broadcasts.map(line),
      queries: rec.queries.map((q) => `${shortSql(q.sql)} :: ${line(q.params)}`),
      llm: rec.llm,
      billing: rec.billing.map(line),
      worker: rec.worker.map(line),
      calls: rec.calls.map(line),
      unusedLlmSteps: llmScript.length + pillScript.length,
      messages: db.messages.map((m) => line({ role: m.role, content: normalizeValue(m.content), metadata: normalizeValue(m.metadata) })),
    };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── Golden bookkeeping ───────────────────────────────────────────────────

const golden = fs.existsSync(GOLDEN_PATH) ? JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) : {};
const recorded = {};
process.on('exit', () => {
  if (!UPDATE) return;
  fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ ...golden, ...recorded }, null, 2)}\n`);
});

function check(name, result) {
  if (UPDATE) { recorded[name] = result; return; }
  assert.ok(golden[name], `no golden recorded for "${name}" — run with UPDATE_GOLDEN=1 once, deliberately`);
  assert.deepEqual(result, golden[name]);
}

const USAGE = { input_tokens: 120, output_tokens: 30 };
const pills = (...replies) => ({ id: 'tu-pills', name: 'suggest_replies', input: { replies } });

// ── Scenarios: Mayor-only turns ──────────────────────────────────────────

test('reply-only first turn: open proposals, prior build folded into history, Mayor pills', async () => {
  const result = await runTurn({
    session: { cloned_from_session_id: null },
    history: [],
    openProposals: [{ id: 11, pr_number: 39, pr_url: 'https://github.com/x/y/pull/39', pr_title: 'Export a board as PNG', status: 'promoted', linked_issues: [], spec_md: '', username: 'maya' }],
    llmSteps: [{
      text: 'Request #34 asks for exactly this. Want a quick spec first?',
      toolUses: [pills('Write the spec for #34', 'Keep the toggle in the toolbar', 'Which screens change?')],
      usage: USAGE,
      rawContent: [],
      stopReason: 'tool_use',
    }],
  });
  check('reply-only first turn', result);
});

test('data-tool loop: web_fetch resolved in-process, then a reply', async () => {
  const result = await runTurn({
    history: [
      { role: 'user', content: 'Earlier ask' },
      { role: 'assistant', content: 'Earlier plan.' },
      { role: 'system', content: 'Coding agent finished.', metadata: { ccOutput: 'Changed theme.js and added a toggle.' } },
    ],
    message: 'What does https://example.com/spec say?',
    llmSteps: [
      {
        text: 'Let me read that page.',
        toolUses: [{ id: 'tu-fetch', name: 'web_fetch', input: { url: 'https://example.com/spec' } }],
        usage: USAGE,
        rawContent: [{ type: 'text', text: 'Let me read that page.' }, { type: 'tool_use', id: 'tu-fetch', name: 'web_fetch', input: { url: 'https://example.com/spec' } }],
        stopReason: 'tool_use',
      },
      {
        text: 'The page says hello, so there is nothing to change yet.',
        toolUses: [pills('Draft a spec anyway', 'Read the issue list', 'What would change?')],
        usage: USAGE,
        rawContent: [],
        stopReason: 'tool_use',
      },
    ],
  });
  check('data-tool loop', result);
});

test('whole-chain refusal ends the turn with a status and no dispatch', async () => {
  const result = await runTurn({
    llmSteps: [{
      text: '',
      toolUses: [{ id: 'tu-build', name: 'dispatch_claude_code', input: { prompt: 'Do it' } }],
      usage: USAGE,
      rawContent: [],
      stopReason: 'refusal',
      stopDetails: { category: 'cyber' },
      servedModel: 'claude-fallback',
    }],
  });
  check('refusal', result);
});

test('fallback-served reply records the fallback once and prices the served model', async () => {
  const result = await runTurn({
    llmSteps: [{
      text: 'Here is the plan.',
      toolUses: [pills('Build the spec', 'Change the toggle icon', 'What files change?')],
      usage: USAGE,
      rawContent: [],
      stopReason: 'end_turn',
      fallbackServed: true,
      servedModel: 'claude-sonnet-5',
      stopDetails: { category: 'bio' },
    }],
  });
  check('fallback served', result);
});

test('generic pills escalate to the enforced re-ask', async () => {
  const result = await runTurn({
    llmSteps: [
      {
        text: 'Sure, happy to help.',
        toolUses: [pills('Preview the change', 'Propose it to the group', 'Make another tweak')],
        usage: USAGE,
        rawContent: [],
        stopReason: 'tool_use',
      },
    ],
    pillSteps: [
      // llm.requireQuickReplies hands back the tool INPUT, { replies: [...] }.
      { replies: { replies: ['Keep the moon icon', 'Default to the system theme', 'Which pages get dark colours?'] }, usage: USAGE, model: 'claude-haiku' },
    ],
  });
  check('generic pills enforced', result);
});

test('an unusable enforced set falls to the generated backstop', async () => {
  const result = await runTurn({
    llmSteps: [
      {
        text: 'Sure, happy to help.',
        toolUses: [pills('Preview the change', 'Propose it to the group', 'Make another tweak')],
        usage: USAGE,
        rawContent: [],
        stopReason: 'tool_use',
      },
    ],
    pillSteps: [
      { replies: { replies: [] }, usage: USAGE, model: 'claude-haiku' },
      { replies: { replies: ['Use a darker grey', 'Keep the toolbar light', 'What about exports?'] }, usage: USAGE, model: 'claude-haiku' },
    ],
  });
  check('generic pills generated', result);
});

test('tool-only suggest_answers reply is salvaged into visible text', async () => {
  const result = await runTurn({
    llmSteps: [{
      text: '',
      toolUses: [{ id: 'tu-qa', name: 'suggest_answers', input: { questions: [{ question: 'Should it follow the system theme?', answers: ['Yes', 'No, always light by default'] }] } }],
      usage: USAGE,
      rawContent: [],
      stopReason: 'tool_use',
    }],
  });
  check('salvaged suggest_answers', result);
});

test('stop during phase 1 ends with a Stopped status', async () => {
  const result = await runTurn({
    llmSteps: [(args) => {
      const handle = stopRegistry.get(BASE_SESSION.id);
      handle.stopped = true;
      handle.stoppedBy = 'tester';
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }],
  });
  check('stop in phase 1', result);
});

test('provider error mid-turn is persisted as a turn failure', async () => {
  const result = await runTurn({
    llmSteps: [{ throw: 'overloaded', errorProps: { status: 529 } }],
  });
  check('provider error', result);
});

test('unconfigured model ends the turn with an error event', async () => {
  const original = llm.isEnabled;
  llm.isEnabled = () => false;
  try {
    const result = await runTurn({ llmSteps: [] });
    check('llm not configured', result);
  } finally {
    llm.isEnabled = original;
  }
});

// ── Scenarios: dispatch turns ────────────────────────────────────────────

const SCOUT_SPEC = [
  '# Dark mode toggle',
  '',
  '## Summary',
  'A sun/moon button in the toolbar switches themes. The choice is saved on each device.',
  '',
  '## Questions',
  'None.',
].join('\n');

const scoutCall = (prompt = 'Write a spec for a toolbar dark mode toggle.') => ({
  text: 'I will write a short spec first.',
  toolUses: [{ id: 'tu-scout', name: 'dispatch_scout', input: { prompt, addresses_issues: [34] } }],
  usage: USAGE,
  rawContent: [
    { type: 'text', text: 'I will write a short spec first.' },
    { type: 'tool_use', id: 'tu-scout', name: 'dispatch_scout', input: { prompt, addresses_issues: [34] } },
  ],
  stopReason: 'tool_use',
});
const buildCall = (prompt = 'Build the dark mode toggle from the spec.') => ({
  text: 'Building it now.',
  toolUses: [{ id: 'tu-build', name: 'dispatch_claude_code', input: { prompt } }],
  usage: USAGE,
  rawContent: [
    { type: 'text', text: 'Building it now.' },
    { type: 'tool_use', id: 'tu-build', name: 'dispatch_claude_code', input: { prompt } },
  ],
  stopReason: 'tool_use',
});
const wrapUp = (text, replies) => ({
  text,
  toolUses: replies ? [pills(...replies)] : [],
  usage: USAGE,
  rawContent: [],
  stopReason: replies ? 'tool_use' : 'end_turn',
});

test('scout turn: spec published, linked issue recorded, wrap-up with pills', async () => {
  const result = await runTurn({
    message: 'Add a dark mode toggle (#34)',
    llmSteps: [
      scoutCall(),
      wrapUp('The spec is in the viewer. Build it when you are ready.', ['Build the spec', 'Make the toggle remember per account', 'What will this change?']),
    ],
    run: async (_id, opts) => ({
      exitCode: 0,
      lastResultText: SCOUT_SPEC,
      sessionId: 'cc-scout-1',
      turnId: 'turn-scout-1',
      ahead: 0,
      pushOk: true,
    }),
  });
  check('scout turn', result);
});

test('build turn: commit, PR opened, staging, wrap-up with pills', async () => {
  const result = await runTurn({
    session: { spec_md: SCOUT_SPEC, cc_session_id: 'cc-scout-1' },
    history: [
      { role: 'user', content: 'Add a dark mode toggle (#34)' },
      { role: 'assistant', content: 'The spec is in the viewer.' },
    ],
    message: 'Build it',
    llmSteps: [
      buildCall(),
      wrapUp('Done. The toggle is in the toolbar and remembers each device.', ['Try it in the preview', 'Use a softer dark grey', 'What did it change?']),
    ],
    run: async (_id, opts) => ({
      exitCode: 0,
      lastResultText: 'Added a theme toggle to the toolbar and saved the choice in localStorage.',
      sessionId: 'cc-build-1',
      turnId: 'turn-build-1',
      sha: 'abc1234def5678',
      ahead: 1,
      pushOk: true,
    }),
  });
  check('build turn', result);
});

test('build turn that changes nothing skips the tail', async () => {
  const result = await runTurn({
    session: { spec_md: SCOUT_SPEC },
    message: 'Build it',
    llmSteps: [
      buildCall(),
      wrapUp('The agent found nothing to change.', null),
    ],
    run: async () => ({
      exitCode: 0,
      lastResultText: 'Everything was already in place.',
      sessionId: 'cc-build-2',
      turnId: 'turn-build-2',
      sha: null,
      ahead: 0,
      pushOk: true,
    }),
  });
  check('build no changes', result);
});

test('stop during the build skips the wrap-up', async () => {
  const result = await runTurn({
    session: { spec_md: SCOUT_SPEC },
    message: 'Build it',
    llmSteps: [buildCall()],
    run: async (id) => {
      const handle = stopRegistry.get(id);
      handle.stopped = true;
      handle.stoppedBy = 'tester';
      return {
        exitCode: 143,
        lastResultText: '',
        sessionId: 'cc-build-3',
        turnId: 'turn-build-3',
        ahead: 0,
        pushOk: false,
      };
    },
  });
  check('stop during build', result);
});

test('a busy worker refuses the dispatch with a status', async () => {
  const activeWorkers = require('../src/services/active-workers');
  const release = activeWorkers.beginSessionOperation(BASE_SESSION.id);
  try {
    const result = await runTurn({
      message: 'Build it',
      llmSteps: [
        // With the worker busy the Mayor is not offered the dispatch tools,
        // so this is a plain reply.
        wrapUp('The coding agent is still running. I will wait for it.', ['How is it going?', 'Stop this build', 'What is it doing?']),
      ],
    });
    check('worker busy', result);
  } finally {
    release();
  }
});

// ── Scenarios: OpenRouter sessions ───────────────────────────────────────

const OR_SESSION = { agent_backend: 'codex_openrouter', agent_model: 'openai/gpt-5.3-codex' };
const directBuild = async () => ({
  exitCode: 0,
  lastResultText: 'Added the toggle.',
  agentThreadId: 'thread-1',
  providerDispatched: true,
  turnId: 'turn-or-1',
  sha: 'fed9876abc1234',
  ahead: 1,
  pushOk: true,
});

test('OpenRouter session: the Mayor runs on the session model and key', async () => {
  const result = await runTurn({
    session: OR_SESSION,
    openRouterMayor: { usesIncludedKey: false },
    llmSteps: [{
      text: 'Sure. Should the toggle live in the toolbar?',
      toolUses: [pills('Put it in the toolbar', 'Put it in settings', 'What changes for users?')],
      usage: USAGE,
      rawContent: [],
      stopReason: 'tool_use',
    }],
  });
  check('openrouter mayor reply', result);
});

test('OpenRouter session: a Mayor failing before it speaks hands the turn to the agent', async () => {
  const result = await runTurn({
    session: OR_SESSION,
    openRouterMayor: { usesIncludedKey: false },
    llmSteps: [{ throw: 'provider refused tools', errorProps: { status: 400 } }],
    run: directBuild,
  });
  check('openrouter mayor fails to direct', result);
});

test('OpenRouter session without a Mayor runs the direct turn', async () => {
  const result = await runTurn({
    session: OR_SESSION,
    openRouterMayor: { error: 'disabled' },
    run: directBuild,
  });
  check('openrouter direct', result);
});
