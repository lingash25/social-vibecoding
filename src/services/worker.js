'use strict';

const { spawn } = require('child_process');
const net = require('node:net');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const github = require('./github');
const models = require('./models');
const inLoopBrowser = require('./in-loop-browser');
const registry = require('../agents/registry');
const turnLifecycle = require('./turn-lifecycle');
const branchNames = require('./branch-names');
const llmTelemetry = require('./llm-telemetry');
const liveAgentSpend = require('./live-agent-spend');
const workerProgress = require('./worker-progress');

const WORKER_IMAGE = 'usernode-worker:latest';
// Per-session worker container resource limits. Read from env (mirrored
// into src/config.js as workerMemory/workerCpus for logging) so prod can
// shrink the footprint to fit more concurrent warm workers on one box
// without a code deploy. Defaults preserve historical 2g/2-CPU behavior.
const WORKER_MEMORY = process.env.WORKER_MEMORY || '2g';
const WORKER_CPUS = process.env.WORKER_CPUS || '2';
const WARM_READY_TIMEOUT_MS = 5 * 60 * 1000;
let accountDeletionGuard = async () => {};
function setAccountDeletionGuard(guard) { accountDeletionGuard = guard; }

function usesKubernetesWorkers() {
  const mode = process.env.WORKER_RUNTIME || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(mode)) {
    throw new Error(`Unsupported WORKER_RUNTIME=${mode}`);
  }
  return mode === 'kubernetes';
}

function kubernetesWorkerConfig() {
  return {
    workerMemory: WORKER_MEMORY,
    workerCpus: WORKER_CPUS,
    workerContractVersion: WORKER_BOOTSTRAP_ENV_VERSION,
    kubernetes: {
      workerNamespace: process.env.WORKER_NAMESPACE || 'social-workers',
      workerServiceAccount: process.env.WORKER_SERVICE_ACCOUNT || 'social-worker',
      workerImage: process.env.KUBERNETES_WORKER_IMAGE || '',
      workerStorageClass: process.env.WORKER_STORAGE_CLASS || '',
      workerStorageSize: process.env.WORKER_STORAGE_SIZE || '5Gi',
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function execWorkerCommand(runtimeName, command, stdinText = null, { timeoutMs = stdinText === null ? 30000 : 20000 } = {}) {
  if (usesKubernetesWorkers()) {
    return kubernetes.execInWorker(kubernetesWorkerConfig(), runtimeName, command, stdinText, { timeoutMs });
  }
  if (stdinText !== null) {
    return docker.execShellStdin(runtimeName, stdinText, { timeoutMs, label: 'worker exec' });
  }
  return docker.execFileAsync('docker', ['exec', runtimeName, ...command], { timeout: timeoutMs });
}

// URL the worker container uses to reach the platform's internal API
// (push proxy, PR creation, etc.). Both containers run on the same
// docker network (compose service name `usernode`). Override via env
// for self-hosted deployments that put the platform on a different
// hostname / port.
const PLATFORM_INTERNAL_URL = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';

// Shots controls are intentionally process-local: the run's paired
// environments and callbacks live in the Pod that scheduled it. During a
// rolling update the shared Service also points at the other color, so a
// shots worker must call this Pod directly or half its tools see an empty
// control registry. Ordinary worker traffic remains on the shared Service.
function shotsControlUrl({ podIp = process.env.POD_IP, port = process.env.PORT,
  fallback = PLATFORM_INTERNAL_URL } = {}) {
  const family = net.isIP(String(podIp || ''));
  const selectedPort = Number(port || 3000);
  if (!family || !Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    return fallback;
  }
  const host = family === 6 ? `[${podIp}]` : podIp;
  return `http://${host}:${selectedPort}`;
}

// Worker JWTs are short-lived but cover the entire chat session; 24h is
// the cap any single session is allowed to run before re-auth becomes
// the chat handler's problem. Re-minted on every warm bootstrap and on
// every per-turn `docker exec`. The TTL itself lives with the signer in
// services/platform-jwt.js; kept here as the name the comments below use.
const WORKER_JWT_TTL = platformJwt.WORKER_TTL;
const WORKER_JWT_TTL_MS = platformJwt.WORKER_TTL_S * 1000;

// Version of the warm-container runtime contract. Bump whenever either the
// bootstrap environment OR an installed runner changes incompatibly with the
// host (e.g. token requirements, journal markers, retry behavior). ensureWorker
// compares this label on warm-path hits and evicts + re-bootstraps containers
// running an older contract. v4 introduces capability-scoped runner envs and
// the host-managed Codex resume classifier, so a v3 image cannot serve it.
// v5 replaces the unsafe Codex config writer and removes any v4-generated
// config from the persistent session volume before the next turn.
// v6 disables Codex's incompatible nested Linux sandbox and adds per-model
// OpenRouter metadata; every v5 warm container must be replaced to pick up
// both runner changes.
// v7 moves hosted Claude's platform handbook into an appended system-prompt
// file, outside the accumulating user-message history.
// v8 adds the separate complete user-prompt fallback for optimized resumed
// builds. A v7 runner would retry a stale --resume with the compact prompt and
// no scout history, so every older warm container must be replaced first.
// v9: refresh warm workers so run-cc.sh emits partial usage events (#1600).
// v10 publishes bootstrap readiness and fences turns after container restarts.
// v11 refreshes warm workers so synthetic OpenRouter models use a
// provider-neutral identity instead of claiming to be GPT (#2120).
// v12 is the bootstrap generation before the Codex provider retry budget.
// v13 refreshes warm workers so the generated Codex config bounds the CLI's
// own reconnect budget instead of retrying a refused request five times
// (#2676).
// v14 installs the OpenRouter request adapter so output limits reach the wire.
// v15 refreshes warm workers so the Codex model catalog compacts a thread at
// 200k tokens instead of 90% of a long model window.
const WORKER_BOOTSTRAP_ENV_VERSION = 'v15';

// Mint the auth token the worker container uses to call back into the
// platform's internal API. Scoped to a single session id; the
// internal-auth middleware rejects anything whose purpose isn't
// worker:session.
//
// Signed with WORKER_JWT_SECRET — an authority of its own, independent
// of the key that signs app identities. The signing key is never put in
// a worker (or app, or staging) container; workers receive only the
// minted capability token. platform-jwt reads the key from env at call
// time, which also preserves the old laziness here: module import can
// precede config.load().
function mintWorkerJwt(sessionId) {
  return platformJwt.signWorkerToken({ sessionId });
}

// Narrow, purpose-bound capabilities. worker:push is used by Codex build's
// usernode-push; worker:issues-read by usernode-issues / attachments on both
// backends; worker:anthropic-proxy authenticates Claude itself without also
// granting the shell every worker:session mutation.
function mintWorkerPushJwt(sessionId) {
  return platformJwt.signWorkerPushToken({ sessionId });
}
function mintIssuesReadJwt(sessionId) {
  return platformJwt.signIssuesReadToken({ sessionId });
}
function mintAnthropicProxyJwt(sessionId) {
  return platformJwt.signAnthropicProxyToken({ sessionId });
}

// #616: purpose-bound read-only diagnostic token carrying the `prod_debug`
// claim that the internal prod-debug routes require. Minted ONLY for turns whose
// session passed debug-access.isEligible (admin-owned session on the
// self-edit app). It is deliberately not worker:session: a scout may inspect
// this env value through Bash without gaining push or draft authority.
function mintProdDebugJwt(sessionId) {
  return platformJwt.signProdDebugToken({ sessionId });
}

function mintShotsJwt(sessionId, runId) {
  return platformJwt.signShotsToken({ sessionId, runId });
}

// One backend decision, used everywhere in a turn's dispatch so the
// runner, tokens, env, and active-turn record can never disagree (review
// Commit 1 / plan 3.1). Rejects unknown backends instead of silently
// falling through to Claude.
//
// #3296 split the OpenRouter backend by harness. The flags below keep their
// historical meaning and add the new case alongside them:
//   isClaude            claude_code: Claude Code on Anthropic (proxy or BYOK)
//   isCodex             codex_openrouter run by the Codex CLI
//   isClaudeOpenRouter  codex_openrouter run by Claude Code, through the
//                       worker-local Messages adapter (worker/claude-
//                       openrouter-request.js) that holds the user's key
//   isOpenRouter        either OpenRouter case: the user's key, the
//                       agent_turns ledger, narrow capability tokens only
//   runsClaude          the runner is run-cc.sh and the journal is Claude
//                       stream-json, whoever the provider is
function resolveTurnBackend(agentBackend, agentHarness = null) {
  const backend = registry.resolveBackend(agentBackend || 'claude_code');
  const isOpenRouter = backend === 'codex_openrouter';
  const harness = isOpenRouter ? registry.resolveOpenRouterHarness(agentHarness) : null;
  return {
    backend,
    harness,
    isOpenRouter,
    isCodex: isOpenRouter && harness === 'codex',
    isClaudeOpenRouter: isOpenRouter && harness === 'claude',
    isClaude: backend === 'claude_code',
    runsClaude: !isOpenRouter || harness === 'claude',
  };
}

function requireNonEmptySecret(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`buildTurnSecretEnv: ${name} required`);
  }
  return value;
}

// Pure builder for a turn's secret env (exported for unit tests).
// Scout mode omits every general worker:session alias, not merely the
// WORKER_JWT name: unrestricted Bash can inspect and reuse any env value.
// PROD_DEBUG_JWT rides along on build + scout turns only — never sync
// (bookkeeping, no free-form agent).
function buildTurnSecretEnv({
  mode, agentBackend, agentHarness = null, workerSessionJwt, workerPushJwt, issuesReadJwt,
  anthropicProxyJwt, anthropicApiKey, prodDebugJwt, openrouterApiKey,
  shotsJwt, shotsMemberToken, shotsAdminToken, shotsFullAdminToken,
  homeroomMcpToken = null,
}) {
  const {
    backend, isCodex, isClaude, isClaudeOpenRouter,
  } = resolveTurnBackend(agentBackend, agentHarness);
  if (!isClaude && !isCodex && !isClaudeOpenRouter) {
    throw new Error(`buildTurnSecretEnv: unsupported backend ${agentBackend}`);
  }
  if (!['scout', 'build', 'sync', 'shots'].includes(mode)) {
    throw new Error(`buildTurnSecretEnv: unsupported mode ${mode}`);
  }
  // Every shots turn runs on Claude Code; the Codex runner has
  // no shots mode.
  if (isCodex && (mode === 'sync' || mode === 'shots')) {
    throw new Error(`buildTurnSecretEnv: Codex ${mode} mode is not supported`);
  }
  if (isClaudeOpenRouter && (mode === 'sync' || mode === 'shots')) {
    throw new Error(`buildTurnSecretEnv: Claude over OpenRouter ${mode} mode is not supported`);
  }

  if (isClaudeOpenRouter) {
    // #3296: the same capability set as a Codex turn — the model provider is
    // the user's OpenRouter key either way, and that is what decides trust,
    // not which CLI drives it. The key reaches only the worker-local adapter;
    // run-cc.sh hands it to that one process and Claude Code itself gets a
    // per-invocation local token. No Anthropic key, proxy base or general
    // worker:session token, and no production-debug grant.
    const env = { OPENROUTER_API_KEY: requireNonEmptySecret(openrouterApiKey, 'openrouterApiKey') };
    env.ISSUES_JWT = requireNonEmptySecret(issuesReadJwt, 'issuesReadJwt');
    if (mode === 'build') {
      env.WORKER_JWT = requireNonEmptySecret(workerPushJwt, 'workerPushJwt');
    }
    if (homeroomMcpToken && HOMEROOM_READ_MODES.has(mode)) env.HOMEROOM_MCP_TOKEN = homeroomMcpToken;
    return env;
  }

  if (isCodex) {
    // Codex receives ONLY its own credential plus narrow capability tokens
    // (review Commit 1 / plan 3.3). It must never receive a general
    // worker:session token, an Anthropic key/base, or a relay token.
    const env = { OPENROUTER_API_KEY: requireNonEmptySecret(openrouterApiKey, 'openrouterApiKey') };
    env.ISSUES_JWT = requireNonEmptySecret(issuesReadJwt, 'issuesReadJwt');
    if (mode === 'build') {
      env.WORKER_JWT = requireNonEmptySecret(workerPushJwt, 'workerPushJwt');
    }
    if (homeroomMcpToken && HOMEROOM_READ_MODES.has(mode)) env.HOMEROOM_MCP_TOKEN = homeroomMcpToken;
    return env;
  }

  // Claude uses a narrow proxy credential when no BYOK key is provided and a
  // narrow issues-read credential in every mode. Only build/sync receive the
  // general callback token. In particular, scout has no worker:session token
  // hidden under ANTHROPIC_API_KEY, ISSUES_JWT, or PROD_DEBUG_JWT.
  const useProxy = !anthropicApiKey;
  const env = {
    ANTHROPIC_API_KEY: useProxy
      ? requireNonEmptySecret(anthropicProxyJwt, 'anthropicProxyJwt')
      : requireNonEmptySecret(anthropicApiKey, 'anthropicApiKey'),
  };
  if (mode !== 'shots') env.ISSUES_JWT = requireNonEmptySecret(issuesReadJwt, 'issuesReadJwt');
  if (mode !== 'scout' && mode !== 'shots') {
    env.WORKER_JWT = requireNonEmptySecret(workerSessionJwt, 'workerSessionJwt');
  }
  if (prodDebugJwt && mode !== 'sync') {
    env.PROD_DEBUG_JWT = prodDebugJwt;
  }
  if (mode === 'shots') {
    env.SHOTS_JWT = requireNonEmptySecret(shotsJwt, 'shotsJwt');
    env.SHOTS_MEMBER_TOKEN = requireNonEmptySecret(shotsMemberToken, 'shotsMemberToken');
    env.SHOTS_ADMIN_TOKEN = requireNonEmptySecret(shotsAdminToken, 'shotsAdminToken');
    env.SHOTS_FULL_ADMIN_TOKEN = requireNonEmptySecret(shotsFullAdminToken, 'shotsFullAdminToken');
  }
  if (homeroomMcpToken && HOMEROOM_READ_MODES.has(mode)) env.HOMEROOM_MCP_TOKEN = homeroomMcpToken;
  return env;
}

// ── The coding agent's read-only platform MCP (#2779) ──────────────────
//
// A build or scout turn gets a `worker_read` delegation (services/mcp-oauth):
// six read tools on the platform's own MCP, bound to this change and its
// app, as the change's owner. worker/homeroom-read-mcp.js bridges them into
// Claude Code and Codex. The agent runs the repository's own code with a
// shell, so assume it can read the token: it reads only what the owner can
// already see on that one app, and only until the turn ends — it is revoked
// in execInWorker's `finally`, and the grant's liveness check refuses it as
// soon as the change is paused or closed. Minting is best effort: a turn
// never fails because the platform could not give it this.
const HOMEROOM_READ_MODES = new Set(['build', 'scout']);
// Bounded by the turn's own length; revocation normally ends it far sooner.
const HOMEROOM_READ_TTL_SECONDS = 2 * 60 * 60;

async function mintHomeroomReadGrant(sessionId, mode) {
  if (!HOMEROOM_READ_MODES.has(mode)) return null;
  const pool = _getPoolSafe();
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `SELECT user_id, app_id FROM chat_sessions
        WHERE id = $1 AND status IN ('active', 'promoted')`,
      [sessionId]
    );
    if (!rows.length) return null;
    const grant = await require('./mcp-oauth').issueDelegatedAccess(pool, {
      userId: rows[0].user_id,
      kind: 'worker_read',
      changeId: Number(sessionId),
      appId: rows[0].app_id,
      ttlSeconds: HOMEROOM_READ_TTL_SECONDS,
    });
    return { token: grant.accessToken, grantId: grant.grantId };
  } catch (err) {
    log.warn('worker', 'Read-only platform MCP not issued for this turn', { sessionId, err: err.message });
    return null;
  }
}

async function revokeHomeroomReadGrant(sessionId, grant) {
  if (!grant) return;
  const pool = _getPoolSafe();
  if (!pool) return;
  await require('./mcp-oauth').revokeDelegation(pool, { grantId: grant.grantId, reason: 'turn_finished' })
    .catch((err) => log.warn('worker', 'Read-only platform MCP revoke failed', { sessionId, err: err.message }));
}
// ──────────────────────────────────────────────────────────────────────
// Stream-json / marker parsing
// ──────────────────────────────────────────────────────────────────────
//
// Claude Code emits one JSON object per stdout line (`--output-format
// stream-json --verbose`). The worker entrypoint additionally emits a
// handful of sentinel lines the host relies on:
//
//   __USERNODE_PHASE__  <phase>                                                  status transitions
//   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N [sync_result=…]   final summary
//   __USERNODE_WARN__   <msg>                                                    non-fatal issue
//   __USERNODE_ERROR__  <msg>                                                    fatal, bail out
//
// Everything else is treated as a plain progress line (git output, etc.).
//
// Two transports drive this parser:
//   1) `docker logs -f <container>` — used for legacy single-shot
//      workers and for the warm-ready wait during bootstrap.
//   2) Turn journal files in the CC volume — per-turn output for the
//      long-lived worker path. run-cc.sh runs as a DETACHED exec whose
//      output is redirected to the journal (plus a trailing
//      __USERNODE_EXIT__ <code> line from the wrapper); the host tails
//      the file. Same line format, but restart-proof: the journal and
//      the exec both outlive the platform process.

function parseClaudeResponse(stdout) {
  // Keep for back-compat with callers that still pass a full stdout blob.
  const lines = (stdout || '').split('\n').filter(Boolean);
  let resultText = '';
  let costUsd = 0;
  let sessionId = null;
  let isError = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        resultText = event.result || resultText;
        costUsd = event.cost_usd || event.total_cost_usd || costUsd;
        sessionId = event.session_id || sessionId;
        if (event.is_error) isError = true;
      }
    } catch {
      // Not JSON — skip.
    }
  }

  return { text: resultText, costUsd, numTurns: 0, sessionId, isError };
}

// Best-effort one-line summary of a tool_result payload. The content is
// either a string (typical for Read/Bash) or an array of content blocks
// (image + text for tools like Playwright). We don't want to spam the
// progress log with the entire file, so just surface length/lines and
// trim hard.
function summarizeToolResult(block) {
  if (block.is_error) return 'error';
  const raw = block.content;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  if (!text) return 'ok';
  const lines = text.split('\n');
  if (lines.length > 3) return `${lines.length} lines`;
  // Short payloads (e.g. bash exit, quick grep) — show the last
  // non-empty line so the user sees the actual outcome.
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim()) || '';
  const trimmed = lastNonEmpty.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function usageToken(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/**
 * #2737, corrected in #2870: tell a watching caller what the turn has spent.
 *
 * This is the ONLY seam a caller has for watching usage while a turn is
 * still running — everything else about usage is terminal, written to the
 * ledger once the turn ends. It must therefore be reachable from EVERY path
 * that learns a token count, not just one: the hook first shipped called
 * only from `applyClaudeResultUsage`, on the Claude `result` event, and the
 * Codex/OpenRouter agent reports usage through a different branch entirely.
 * A budget built on it was silently inert on that agent for its whole first
 * day in production.
 *
 * Note what this does NOT buy (#3035). Both paths are terminal: Claude's
 * usage arrives on its `result` event and `codex-openrouter`'s on
 * `turn.completed`, each the last thing a turn emits. A caller can REPORT
 * that a finished turn breached a token budget; it cannot stop a turn with
 * this, and must never treat a breach seen here as a reason to discard a
 * finished result — the Homeroom bot did exactly that for a day. On Codex
 * the figure is also the THREAD's running total, not the turn's. Giving an
 * agent a mid-turn signal is an upstream change this seam cannot fake.
 *
 * Optional and best-effort by construction: a throwing hook must never take
 * down the parse of a provider event.
 */
function notifyUsage(state) {
  if (!state || typeof state.onUsage !== 'function') return;
  try {
    state.onUsage({
      inputTokens: state.inputTokens,
      cachedInputTokens: state.cachedInputTokens,
      outputTokens: state.outputTokens,
    });
  } catch (err) {
    log.warn('worker', 'onUsage hook threw (ignored)', { err: err.message });
  }
}

function applyClaudeResultUsage(usage, state) {
  if (!usage || typeof usage !== 'object') return;
  const values = {
    inputTokens: usageToken(usage.input_tokens),
    cachedInputTokens: usageToken(usage.cache_read_input_tokens),
    cacheWriteInputTokens: usageToken(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens,
    ),
    outputTokens: usageToken(usage.output_tokens),
    reasoningOutputTokens: usageToken(
      usage.reasoning_output_tokens ?? usage.output_tokens_details?.thinking_tokens,
    ),
    cacheWrite5mInputTokens: usageToken(
      usage.cache_creation?.ephemeral_5m_input_tokens,
    ),
    cacheWrite1hInputTokens: usageToken(
      usage.cache_creation?.ephemeral_1h_input_tokens,
    ),
    serverWebSearchCount: usageToken(usage.server_tool_use?.web_search_requests),
    serverWebFetchCount: usageToken(usage.server_tool_use?.web_fetch_requests),
  };
  const hasUsageMetadata = typeof usage.service_tier === 'string'
    || typeof usage.inference_geo === 'string';
  if (!Object.values(values).some((value) => value != null) && !hasUsageMetadata) return;
  state.usageSeen = true;
  for (const [key, value] of Object.entries(values)) {
    if (value != null) state[key] = value;
  }
  notifyUsage(state);
  if (typeof usage.service_tier === 'string') state.serviceTier = usage.service_tier;
  if (typeof usage.inference_geo === 'string') state.inferenceRegion = usage.inference_geo;
}

function safeResultSubtype(value) {
  if (typeof value !== 'string') return null;
  const subtype = value.trim();
  return /^[a-z][a-z0-9_]{0,63}$/.test(subtype) ? subtype : null;
}

// A shots turn runs on its own pinned model
// (shots-agent), which the author-facing allowlist does not list:
// resolve() would turn it back into the author default. Any Claude id is
// accepted there by shape; every other turn stays on the allowlist.
const SHOTS_AGENT_MODEL_RE = /^claude-[a-z0-9][a-z0-9-]{0,62}$/;
function claudeTurnModel(mode, model) {
  return mode === 'shots' && SHOTS_AGENT_MODEL_RE.test(String(model || ''))
    ? model : models.resolve(model);
}

// Shots diagnostics deliberately record only a fixed vocabulary. Page
// text, tool arguments/results, URLs, provider messages and journal lines can
// contain private app data or credentials and must never enter a run trace.
const SHOTS_DIAGNOSTIC_TOOLS = new Set([
  'get_brief', 'save_shot', 'save_clip', 'skip_change', 'note_change', 'fail_request',
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close',
]);
const SHOTS_DIAGNOSTIC_PHASES = new Set([
  'refresh', 'shots_proxy', 'shots_browser_bootstrap',
  'shots_mcp_ready', 'claude', 'agent', 'done',
]);

function shotsDiagnosticTool(name) {
  const parts = String(name || '').split(/__|[./]/);
  const tool = parts.at(-1);
  if (!SHOTS_DIAGNOSTIC_TOOLS.has(tool)) return { tool: 'other' };
  const server = parts.includes('browser_member') ? 'member'
    : parts.includes('browser_full_admin') ? 'full_admin'
      : parts.includes('browser_admin') ? 'admin' : null;
  return { tool, ...(server ? { persona: server } : {}) };
}

function shotsNavigationTarget(state, input) {
  if (!state.shotsOrigins) return {};
  let args = input;
  if (typeof args === 'string' && args.length <= 8192) {
    try { args = JSON.parse(args); } catch { return {}; }
  }
  if (!args || typeof args.url !== 'string') return {};
  let destination;
  try { destination = new URL(args.url); } catch { return {}; }
  let side = null;
  for (const candidate of ['base', 'head']) {
    try {
      if (destination.origin === new URL(state.shotsOrigins?.[candidate]).origin) {
        side = candidate;
        break;
      }
    } catch { /* No paired origin is available in a non-shots turn. */ }
  }
  if (!side) return { side: 'outside' };
  // Only an ordinal leaves the worker. It distinguishes repeated routes and
  // base/head navigation without storing private paths, queries, or tokens.
  const routes = state.shotsRouteOrdinals || (state.shotsRouteOrdinals = new Map());
  const key = `${destination.pathname}${destination.search}${destination.hash}`;
  if (!routes.has(key) && routes.size < 1000) routes.set(key, routes.size + 1);
  const hints = state.shotsNavigationHints || {};
  const checkRank = Array.isArray(hints.declaredPaths) ? hints.declaredPaths.indexOf(key) + 1 : 0;
  const intentStart = Array.isArray(hints.intentPaths) && hints.intentPaths.includes(key);
  return {
    side,
    ...(routes.has(key) ? { routeOrdinal: routes.get(key) } : {}),
    routeHint: checkRank > 0 ? 'declared_check' : intentStart ? 'intent_start' : 'other',
    ...(checkRank > 0 ? { checkRank } : {}),
  };
}

function emitShotsDiagnostic(state, event) {
  if (typeof state?.shotsDiagnosticObserver !== 'function') return;
  try { state.shotsDiagnosticObserver(event); }
  catch { /* Diagnostics must never affect the worker turn. */ }
}

function observeShotsTool(state, { phase, id, name, input = null, failed = false }) {
  if (typeof state?.shotsDiagnosticObserver !== 'function') return;
  const key = id == null ? null : String(id);
  const starts = state.shotsDiagnosticStarts || (state.shotsDiagnosticStarts = new Map());
  const completed = state.shotsDiagnosticCompleted || (state.shotsDiagnosticCompleted = new Set());
  if (phase === 'start') {
    if (key && starts.has(key)) return;
    const sequence = (state.shotsDiagnosticSequence || 0) + 1;
    state.shotsDiagnosticSequence = sequence;
    const tool = shotsDiagnosticTool(name);
    const safeTool = {
      ...tool,
      ...(tool.tool === 'browser_navigate'
        ? shotsNavigationTarget(state, input) : {}),
    };
    if (key) starts.set(key, { sequence, ...safeTool });
    emitShotsDiagnostic(state, { kind: 'tool_start', sequence, ...safeTool });
    return;
  }
  if (key && completed.has(key)) return;
  if (key) completed.add(key);
  const prior = key ? starts.get(key) : null;
  if (key) starts.delete(key);
  emitShotsDiagnostic(state, {
    kind: 'tool_end',
    sequence: prior?.sequence || null,
    ...(prior ? { tool: prior.tool, ...(prior.persona ? { persona: prior.persona } : {}),
      ...(prior.side ? { side: prior.side } : {}),
      ...(prior.routeOrdinal ? { routeOrdinal: prior.routeOrdinal } : {}),
      ...(prior.routeHint ? { routeHint: prior.routeHint } : {}),
      ...(prior.checkRank ? { checkRank: prior.checkRank } : {}) }
      : shotsDiagnosticTool(name)),
    outcome: failed ? 'error' : 'ok',
  });
}

function noteFirstAgentOutput(state) {
  if (!state || state.timeToFirstOutputMs != null) return;
  if (Number.isFinite(state.providerStartedMs)) {
    state.timeToFirstOutputMs = Math.max(0, Date.now() - state.providerStartedMs);
  }
}

function resultMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function collectionCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
}

function shotsToolAvailable(tools, toolName) {
  if (collectionCount(tools) == null) return null;
  const names = Array.isArray(tools)
    ? tools.map((item) => typeof item === 'string' ? item : item?.name)
    : Object.keys(tools);
  return names.some((name) => name === toolName || name === `mcp__shots__${toolName}`);
}

function mcpToolCount(tools, serverName) {
  if (collectionCount(tools) == null) return null;
  const names = Array.isArray(tools)
    ? tools.map((item) => typeof item === 'string' ? item : item?.name)
    : Object.keys(tools);
  return names.filter((name) => typeof name === 'string'
    && name.startsWith(`mcp__${serverName}__`)).length;
}

function shotsContextResultShape(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.find((item) => item?.type === 'text')?.text : null;
  const responseCharacters = typeof text === 'string' ? text.length : 0;
  let value = null;
  try { value = JSON.parse(text); } catch { /* A malformed response is diagnostic data. */ }
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  return {
    responseCharacters,
    jsonValid: !!object,
    declaredChangesPresent: Array.isArray(object?.declaredChanges),
    addressesPresent: !!(object?.addresses?.before && object?.addresses?.after),
    revisionsPresent: !!(object?.revisions?.before && object?.revisions?.after),
    storyCount: Array.isArray(object?.declaredChanges) ? object.declaredChanges.length : null,
  };
}

function addObservedValue(set, value) {
  if (!(set instanceof Set) || typeof value !== 'string' || !value) return;
  set.add(value);
}

function noteToolName(state, name) {
  addObservedValue(state.telemetryToolNames, name);
}

function noteFileRead(state, path) {
  state.fileReadCount += 1;
  addObservedValue(state.telemetryFileReads, path);
}

function noteFileChange(state, path) {
  state.fileChangeCount += 1;
  addObservedValue(state.telemetryFileChanges, path);
}

function noteClaudeToolCall(state, block) {
  const itemKey = block && block.id ? `claude:${block.id}` : null;
  if (itemKey && state.telemetryStartedItemIds.has(itemKey)) return false;
  if (itemKey) state.telemetryStartedItemIds.add(itemKey);
  const name = typeof block?.name === 'string' ? block.name : String(block?.type || 'tool');
  const input = block && block.input && typeof block.input === 'object' ? block.input : {};
  state.toolCallCount += 1;
  noteToolName(state, name);
  if (block?.type === 'server_tool_use' || block?.type === 'mcp_tool_use') {
    state.responseServerToolCallCount += 1;
  } else {
    state.responseToolCallCount += 1;
  }
  if (block?.type === 'mcp_tool_use' || /^mcp(?:__|$)/i.test(name)) state.mcpCallCount += 1;
  if (name === 'Read') noteFileRead(state, input.file_path);
  else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    noteFileChange(state, input.file_path || input.notebook_path);
  } else if (name === 'Bash') state.commandCount += 1;
  else if (['Glob', 'Grep'].includes(name)) state.fileSearchCount += 1;
  else if (['Task', 'Agent'].includes(name)) state.subagentCallCount += 1;
  else if (['WebSearch', 'WebFetch'].includes(name)) state.webToolCallCount += 1;
  else if (name === 'ToolSearch') state.toolSearchCount += 1;
  return true;
}

function codexItemKey(event) {
  return event && event.itemId ? `codex:${event.itemId}` : null;
}

function noteCodexToolStart(state, event) {
  const key = codexItemKey(event);
  if (key && state.telemetryStartedItemIds.has(key)) return false;
  if (key) state.telemetryStartedItemIds.add(key);
  noteFirstAgentOutput(state);
  state.toolCallCount += 1;
  state.responseToolCallCount += 1;
  noteToolName(state, event.toolName || event.kind);
  if (event.kind === 'command_started' || event.kind === 'command_completed') {
    state.commandCount += 1;
  } else if (event.kind === 'file_read' || event.kind === 'file_read_completed') {
    noteFileRead(state, event.resourcePath);
  } else if (event.kind === 'mcp_started' || event.kind === 'mcp_completed') {
    state.mcpCallCount += 1;
  }
  return true;
}

function noteCodexToolCompletion(state, event) {
  if (event.countCompletion === false) return false;
  const key = codexItemKey(event);
  if (key && state.telemetryCompletedItemIds.has(key)) return false;
  if (key) state.telemetryCompletedItemIds.add(key);
  state.toolResultCount += 1;
  if ((event.exitCode != null && Number(event.exitCode) !== 0)
      || (typeof event.status === 'string'
          && ['failed', 'error', 'cancelled'].includes(event.status.toLowerCase()))) {
    state.toolErrorCount += 1;
  }
  return true;
}

// An OpenRouter turn that Claude Code ran (#3296): Claude stream-json in the
// journal, OpenRouter's key and ledger behind it.
function isClaudeOnOpenRouter(state) {
  return state?.agentBackend === 'codex_openrouter' && state?.agentHarness === 'claude';
}

// Give a Claude-harness OpenRouter result the shape every OpenRouter caller
// already reads (#3296): the thread to resume lives in agentThreadId, as a
// Codex thread does, and nothing is written into cc_session_id, which belongs
// to Anthropic Claude Code sessions. Idempotent; a no-op for other turns.
function finalizeHarnessResult(state) {
  if (!isClaudeOnOpenRouter(state)) return state;
  const claudeSessionId = state.sessionId || state.initSessionId || null;
  if (claudeSessionId) state.agentThreadId = claudeSessionId;
  state.sessionId = null;
  state.initSessionId = null;
  return state;
}

function applyStreamEvent(event, onProgress, state) {
  liveAgentSpend.observe(state.liveSpend, event);
  if (event?.type === 'stream_event' && !state.shotsFirstStreamSeen) {
    state.shotsFirstStreamSeen = true;
    emitShotsDiagnostic(state, { kind: 'first_stream' });
  }
  if (state.hostSessionId && state.liveSpendEnabled) {
    workerProgress.setSpend(state.hostSessionId, liveAgentSpend.snapshot(state.liveSpend));
  }
  const observeDiagnostics = state.telemetryDiagnosticsEnabled === true;
  // Claude's init event is the only content-free source for the configured
  // tool/MCP/skill/agent surface. Some wrappers put the CLI event under
  // `data`; accept both shapes without retaining any names.
  const systemEvent = event && event.data?.type === 'system' ? event.data : event;
  if (observeDiagnostics && systemEvent?.type === 'system' && systemEvent.subtype === 'init') {
    const toolCount = collectionCount(systemEvent.tools);
    const mcpCount = collectionCount(systemEvent.mcp_servers ?? systemEvent.mcpServers);
    const agentCount = collectionCount(systemEvent.agents);
    const skillCount = collectionCount(systemEvent.skills);
    const pluginCount = collectionCount(systemEvent.plugins);
    if (toolCount != null) state.requestToolDefinitionCount = toolCount;
    if (mcpCount != null) state.requestMcpServerCount = mcpCount;
    if (agentCount != null) state.requestAgentDefinitionCount = agentCount;
    if (skillCount != null) state.requestSkillCount = skillCount;
    if (pluginCount != null) state.requestPluginCount = pluginCount;
  }
  if (observeDiagnostics && systemEvent?.type === 'system'
      && systemEvent.subtype === 'compact_boundary') {
    state.contextCompactionCount = (state.contextCompactionCount || 0) + 1;
    const metadata = systemEvent.compact_metadata || systemEvent.compactMetadata || {};
    const preTokens = usageToken(metadata.pre_tokens ?? metadata.preTokens);
    if (preTokens != null) {
      state.contextCompactionPreTokensMax = Math.max(
        state.contextCompactionPreTokensMax || 0,
        preTokens,
      );
    }
  }
  if (observeDiagnostics && event?.type === 'rate_limit_event') {
    state.providerRateLimitEventCount = (state.providerRateLimitEventCount || 0) + 1;
  }

  // Capture the CC session id on the very first event so the caller can
  // persist it even if CC aborts before emitting a `result` event.
  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    state.initSessionId = event.session_id;
    state.sessionId = state.sessionId || event.session_id;
  }
  if (systemEvent?.type === 'system' && systemEvent.subtype === 'init'
      && !state.shotsProviderInitSeen) {
    state.shotsProviderInitSeen = true;
    emitShotsDiagnostic(state, {
      kind: 'provider_init',
      mcpServerCount: collectionCount(systemEvent.mcp_servers ?? systemEvent.mcpServers),
      toolDefinitionCount: collectionCount(systemEvent.tools),
      briefToolAvailable: shotsToolAvailable(systemEvent.tools, 'get_brief'),
      saveShotToolAvailable: shotsToolAvailable(systemEvent.tools, 'save_shot'),
      skipChangeToolAvailable: shotsToolAvailable(systemEvent.tools, 'skip_change'),
      browserMemberToolCount: mcpToolCount(systemEvent.tools, 'browser_member'),
      browserAdminToolCount: mcpToolCount(systemEvent.tools, 'browser_admin'),
      browserFullAdminToolCount: mcpToolCount(systemEvent.tools, 'browser_full_admin'),
    });
  }
  if (event.type === 'assistant' && event.message?.content) {
    if (!state.shotsFirstOutputSeen) {
      state.shotsFirstOutputSeen = true;
      emitShotsDiagnostic(state, { kind: 'first_output' });
    }
    if (observeDiagnostics) {
      noteFirstAgentOutput(state);
      state.providerTurnCount = (state.providerTurnCount || 0) + 1;
    }
    for (const block of event.message.content) {
      if (observeDiagnostics) state.responseContentBlockCount += 1;
      if (block.type === 'text') {
        if (observeDiagnostics) {
          state.responseTextBlockCount += 1;
          state.responseTextCharacters += typeof block.text === 'string' ? block.text.length : 0;
        }
        if (block.text) {
          state.lastResultText = block.text;
          onProgress(block.text.substring(0, 300));
        }
      } else if (block.type === 'thinking') {
        if (observeDiagnostics) {
          state.responseThinkingBlockCount += 1;
          state.responseThinkingCharacters += typeof block.thinking === 'string'
            ? block.thinking.length
            : 0;
        }
        // Extended thinking blocks. Without surfacing these the UI can
        // sit on "Reading foo.html" for 30+ seconds while the model
        // thinks about what to do next — misleading. Prefix with `…`
        // so it's visually distinct from tool / text lines.
        const firstLine = String(block.thinking || '').split('\n').find((l) => l.trim()) || '';
        const clipped = firstLine.trim().slice(0, 200);
        if (clipped) onProgress(`… ${clipped}`);
      } else if (block.type === 'redacted_thinking') {
        if (observeDiagnostics) state.responseRedactedThinkingBlockCount += 1;
      } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        if (observeDiagnostics) noteClaudeToolCall(state, block);
        observeShotsTool(state, { phase: 'start', id: block.id, name: block.name, input: block.input });
      } else if (block.type === 'tool_use') {
        if (observeDiagnostics) noteClaudeToolCall(state, block);
        observeShotsTool(state, { phase: 'start', id: block.id, name: block.name, input: block.input });
        const input = block.input || {};
        // Track id → label mapping so the matching tool_result can
        // display "⎿ <label>: <summary>" instead of just "⎿ done".
        let label;
        if (block.name === 'Read' && input.file_path) {
          label = `Reading ${input.file_path}`;
        } else if (block.name === 'Write' && input.file_path) {
          label = `Writing ${input.file_path}`;
        } else if (block.name === 'Edit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'MultiEdit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'Bash' && input.command) {
          label = `$ ${input.command.substring(0, 150)}`;
        } else {
          label = `Using ${block.name}`;
        }
        onProgress(label);
        if (block.id) state.toolUses.set(block.id, { name: block.name, label });
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    // tool_result arrives inside a `user` event after CC executes the
    // tool call. Surfacing it breaks the "Reading X" dead-air and lets
    // the user see CC is progressing through its plan.
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const diagnosticStart = block.tool_use_id == null ? null
        : state.shotsDiagnosticStarts?.get(String(block.tool_use_id));
      if (diagnosticStart?.tool === 'get_brief') {
        emitShotsDiagnostic(state, {
          kind: 'context_result',
          outcome: block.is_error === true ? 'error' : 'ok',
          ...shotsContextResultShape(block.content),
        });
      }
      observeShotsTool(state, {
        phase: 'end', id: block.tool_use_id,
        name: state.toolUses.get(block.tool_use_id)?.name,
        failed: block.is_error === true,
      });
      if (observeDiagnostics) {
        const resultKey = block.tool_use_id ? `claude:${block.tool_use_id}` : null;
        const firstResult = !resultKey || !state.telemetryCompletedItemIds.has(resultKey);
        if (resultKey) state.telemetryCompletedItemIds.add(resultKey);
        if (firstResult) {
          state.toolResultCount += 1;
          if (block.is_error) state.toolErrorCount += 1;
        }
      }
      const summary = summarizeToolResult(block);
      const prior = block.tool_use_id ? state.toolUses.get(block.tool_use_id) : null;
      if (prior) {
        onProgress(`  ⎿ ${prior.name}: ${summary}`);
        state.toolUses.delete(block.tool_use_id);
      } else {
        onProgress(`  ⎿ ${summary}`);
      }
    }
  } else if (event.type === 'result') {
    state.lastResultText = event.result || state.lastResultText;
    applyClaudeResultUsage(event.usage, state);
    state.resultSubtype = safeResultSubtype(event.subtype) || state.resultSubtype;
    state.providerStopReason = safeResultSubtype(event.stop_reason) || state.providerStopReason;
    emitShotsDiagnostic(state, {
      kind: 'provider_result', outcome: event.is_error ? 'error' : 'ok',
      resultSubtype: state.resultSubtype,
      providerStopReason: state.providerStopReason,
    });
    const reportedDuration = observeDiagnostics ? resultMetric(event.duration_ms) : null;
    const providerDuration = observeDiagnostics ? resultMetric(event.duration_api_ms) : null;
    const turns = observeDiagnostics ? usageToken(event.num_turns) : null;
    if (reportedDuration != null) state.agentReportedDurationMs = reportedDuration;
    if (providerDuration != null) state.providerDurationMs = providerDuration;
    if (turns != null) state.providerTurnCount = turns;
    const modelUsage = event.modelUsage && typeof event.modelUsage === 'object'
      && !Array.isArray(event.modelUsage)
      ? event.modelUsage
      : (event.model_usage && typeof event.model_usage === 'object'
        && !Array.isArray(event.model_usage) ? event.model_usage : null);
    if (observeDiagnostics && modelUsage) {
      state.providerModelCount = Object.keys(modelUsage).length;
      for (const modelMetrics of Object.values(modelUsage)) {
        if (!modelMetrics || typeof modelMetrics !== 'object') continue;
        const contextWindow = usageToken(
          modelMetrics.contextWindow ?? modelMetrics.context_window,
        );
        if (contextWindow != null) {
          state.modelContextWindowTokens = Math.max(
            state.modelContextWindowTokens || 0,
            contextWindow,
          );
        }
      }
    }
    if (observeDiagnostics && Array.isArray(event.permission_denials)) {
      state.permissionDenialCount = event.permission_denials.length;
    }
    // #3296: Claude Code prices a run from its own Anthropic price list, which
    // says nothing about an OpenRouter model. An OpenRouter turn is priced by
    // the agent_turns ledger from the catalog snapshot instead, exactly like
    // a Codex turn, so its costUsd stays the unknown zero Codex leaves it at.
    if (!isClaudeOnOpenRouter(state)) {
      if (event.cost_usd != null || event.total_cost_usd != null) {
        state.providerCostSeen = true;
      }
      // Keep the pre-telemetry billing precedence exactly unchanged. The
      // separate flag above is enough to distinguish an explicitly reported
      // zero from this state's legacy zero default.
      state.costUsd = event.cost_usd || event.total_cost_usd || state.costUsd;
    }
    state.sessionId = event.session_id || state.sessionId;
    if (event.is_error) state.ccIsError = true;
  }
}

// Keep OpenRouter calls visible in the owner's coding transcript. The adapter
// emits only timing/counts, but still accept an explicit allowlist here:
// runner output is untrusted and must never echo a prompt, key, URL, or
// provider body into progress.
const CODING_PROVIDER_STAGES = new Set(['await_headers', 'await_first_byte', 'streaming']);
const CODING_PROVIDER_OUTCOMES = new Set(['ok', 'http_error', 'cancelled', 'network_error', 'stream_error']);
function codingProviderCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}
function observeCodingProviderTiming(event, onProgress, state) {
  if (event?.kind === 'codex_output_idle') {
    const durationMs = event.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs > 86_400_000) return;
    if (durationMs < 60_000 || !Number.isSafeInteger(event.activeRequests)
        || event.activeRequests < 0 || event.activeRequests > 1000) return;
    const seconds = Math.round(durationMs / 1000);
    // Codex prints nothing while a command or tool runs, so a quiet stretch
    // is only suspicious when nothing is open. A slow model request already
    // reports itself on its own lines.
    const open = [...(state.codexOpenTools?.values() || [])];
    if (open.length) {
      const latest = open[open.length - 1];
      const more = open.length > 1 ? ` (and ${open.length - 1} more)` : '';
      onProgress(latest.kind === 'command'
        ? `Waiting on a command for ${seconds}s${latest.label ? `: ${latest.label}` : ''}${more}`
        : `Waiting on ${latest.label} for ${seconds}s${more}`);
    } else if (event.activeRequests === 0) {
      onProgress(`Codex has been silent for ${seconds}s with no command or model request open`);
    }
    return;
  }
  const ordinal = event?.requestOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1_000_000) return;
  const requests = state.codingProviderRequests || (state.codingProviderRequests = new Map());
  if (event.kind === 'provider_request_start') {
    const request = { lastReportedMs: null, lastReportedStage: null, contextReported: false };
    requests.set(ordinal, request);
    const payloadBytes = codingProviderCount(event.payloadBytes, 64 * 1024 * 1024);
    const inputBytes = codingProviderCount(event.inputBytes, 64 * 1024 * 1024);
    const instructionBytes = codingProviderCount(event.instructionBytes, 64 * 1024 * 1024);
    const inputItems = codingProviderCount(event.inputItems, 1_000_000);
    const maxOutputTokens = codingProviderCount(event.maxOutputTokens, 10_000_000);
    const linked = event.previousResponseLinked;
    if (payloadBytes != null && inputBytes != null && instructionBytes != null && maxOutputTokens != null
        && typeof linked === 'boolean') {
      const itemCount = inputItems == null ? '' : ` in ${inputItems} items`;
      onProgress(`OpenRouter request #${ordinal}: payload ${payloadBytes} bytes, context ${inputBytes} bytes${itemCount}, `
        + `instructions ${instructionBytes} bytes, previous response ${linked ? 'linked' : 'absent'}, `
        + `reply limit ${maxOutputTokens} tokens`);
      request.contextReported = true;
    }
    return;
  }
  const durationMs = event.durationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000) return;
  const prior = requests.get(ordinal);
  if (event.kind === 'provider_request_pending') {
    if (!CODING_PROVIDER_STAGES.has(event.stage) || durationMs < 30_000) return;
    const request = prior || { lastReportedMs: null, lastReportedStage: null };
    if (request.lastReportedStage === event.stage
        && durationMs - request.lastReportedMs < 60_000) return;
    request.lastReportedMs = durationMs;
    request.lastReportedStage = event.stage;
    requests.set(ordinal, request);
    const seconds = Math.round(durationMs / 1000);
    const stage = {
      await_headers: 'no response headers',
      await_first_byte: 'headers received, no response bytes',
      streaming: 'still responding',
    }[event.stage];
    const bytes = Number.isSafeInteger(event.responseBytes) && event.responseBytes >= 0
      && event.responseBytes <= 10_000_000 ? event.responseBytes : null;
    const transfer = event.stage === 'streaming' && bytes != null ? `, ${bytes} bytes so far` : '';
    onProgress(`OpenRouter request #${ordinal}: ${stage} after ${seconds}s${transfer}`);
    return;
  }
  if (event.kind === 'provider_response_headers' || event.kind === 'provider_response_first_byte') {
    if (!prior || prior.lastReportedMs == null) return;
    if (event.kind === 'provider_response_headers') {
      const status = event.httpStatus;
      if (!Number.isSafeInteger(status) || status < 100 || status > 599) return;
      onProgress(`OpenRouter request #${ordinal}: HTTP ${status} headers after ${Math.round(durationMs / 1000)}s`);
    } else {
      onProgress(`OpenRouter request #${ordinal}: first response byte after ${Math.round(durationMs / 1000)}s`);
    }
    return;
  }
  if (event.kind === 'provider_request_end') {
    requests.delete(ordinal);
    if (!prior || (!prior.contextReported && prior.lastReportedMs == null)
        || !CODING_PROVIDER_OUTCOMES.has(event.outcome)) return;
    const status = Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599
      ? `, HTTP ${event.httpStatus}` : '';
    const responseBytes = codingProviderCount(event.responseBytes, 10_000_000);
    const chunkCount = codingProviderCount(event.chunkCount, 1000);
    const transfer = prior.contextReported && responseBytes != null && chunkCount != null
      ? `, ${responseBytes} response bytes in ${chunkCount} chunks` : '';
    onProgress(`OpenRouter request #${ordinal}: ${event.outcome} after ${Math.round(durationMs / 1000)}s${status}${transfer}`);
  }
}

function parseLine(line, onProgress, state) {
  if (!line || !line.trim()) return;
  if (line.startsWith('__USERNODE_CODING_PROVIDER__ ')) {
    try {
      if (state.agentBackend === 'codex_openrouter') {
        observeCodingProviderTiming(JSON.parse(line.slice('__USERNODE_CODING_PROVIDER__ '.length)), onProgress, state);
      }
    } catch { /* Malformed diagnostics must not change the agent turn. */ }
    return;
  }
  if (line.startsWith('__USERNODE_SHOTS_BROWSER__ ')) {
    try {
      const event = JSON.parse(line.slice('__USERNODE_SHOTS_BROWSER__ '.length));
      if (event && typeof event === 'object' && !Array.isArray(event)) {
        emitShotsDiagnostic(state, event);
      }
    } catch { /* A malformed diagnostic must not change the agent turn. */ }
    return;
  }
  if (line.startsWith('__USERNODE_PHASE__')) {
    state.phase = line.replace('__USERNODE_PHASE__', '').trim();
    const phase = state.phase.split(/[\s(]/, 1)[0];
    if (SHOTS_DIAGNOSTIC_PHASES.has(phase)) {
      emitShotsDiagnostic(state, { kind: 'runner_phase', phase });
    }
    onProgress(`[${state.phase}]`);
    return;
  }
  if (line.startsWith('__USERNODE_RESULT__')) {
    const body = line.replace('__USERNODE_RESULT__', '').trim();
    for (const kv of body.split(/\s+/)) {
      const [k, v] = kv.split('=');
      if (k === 'cc_exit') state.ccExit = parseInt(v, 10);
      else if (k === 'ahead') state.ahead = parseInt(v, 10) || 0;
      else if (k === 'behind') state.behind = parseInt(v, 10) || 0;
      else if (k === 'sha') state.sha = v || null;
      else if (k === 'push_ok') state.pushOk = v === '1';
      else if (k === 'sync_result') state.syncResult = v || null;
      // Backend-neutral antelope (plan.md §4-PR1): Codex/OpenRouter turns
      // (PR5+) emit these fields in __USERNODE_RESULT__ alongside the
      // legacy cc_* fields. Parsing them here keeps worker.js the single
      // place that understands the terminal result line, with the legacy
      // cc_exit alias still honored during the migration window.
      else if (k === 'agent_backend') state.agentBackend = v || null;
      else if (k === 'agent_provider') state.agentProvider = v || null;
      else if (k === 'agent_model') {
        state.agentModel = v || null;
        if (v) state.providerModelCount = Math.max(1, state.providerModelCount || 0);
      }
      else if (k === 'agent_thread_id') state.agentThreadId = v || null;
      else if (k === 'agent_exit') state.agentExit = parseInt(v, 10);
      else if (k === 'agent_retry_fresh') state.agentRetryFresh = v === '1';
      // #361: comma-delimited conflicted file paths (MODE=sync). Empty
      // string → no conflicts. Threaded out as result.conflictFiles so
      // sync-main.js can persist the merge-conflict snapshot.
      else if (k === 'conflict_files') state.conflictFiles = v ? v.split(',').filter(Boolean) : [];
    }
    state.resultSeen = true;
    const terminalExit = Number.isInteger(state.agentExit) ? state.agentExit : state.ccExit;
    emitShotsDiagnostic(state, {
      kind: 'runner_result', outcome: terminalExit === 0 ? 'ok' : 'error',
    });
    return;
  }
  if (line.startsWith('__USERNODE_ERROR__')) {
    state.fatalError = line.replace('__USERNODE_ERROR__', '').trim();
    return;
  }
  if (line.startsWith('__USERNODE_EXIT__')) {
    // Appended by the detached-exec wrapper after run-cc.sh exits — the
    // journal-file analog of the docker-exec child's exit code. Seeing
    // this line is how the journal tailer knows the turn is over.
    const code = parseInt(line.replace('__USERNODE_EXIT__', '').trim(), 10);
    state.exitCode = Number.isFinite(code) ? code : -1;
    state.execExitSeen = true;
    emitShotsDiagnostic(state, { kind: 'runner_exit', outcome: code === 0 ? 'ok' : 'error' });
    return;
  }
  if (line.startsWith('__USERNODE_WARN__')) {
    const msg = line.replace('__USERNODE_WARN__', '').trim();
    log.warn('worker', msg, {
      sessionId: state.hostSessionId,
      containerName: state.hostContainerName,
    });
    // run-cc.sh performs exactly one physical fresh invocation after a failed
    // --resume. Count that retry in the existing content-free diagnostic so
    // telemetry can reveal stale-resume frequency without storing ids, prompt
    // text, or provider errors. Ordinary warnings remain unclassified.
    if (state.telemetryDiagnosticsEnabled === true
        && /^resume failed \(exit -?\d+\); retrying fresh$/.test(msg)) {
      state.providerRetryCount = (state.providerRetryCount || 0) + 1;
      emitShotsDiagnostic(state, { kind: 'resume_retry' });
    }
    // Surface runner warnings ("resume failed (exit N); retrying fresh",
    // "push failed", …) in the session's progress log too — both the
    // interactive and headless paths persist onProgress lines, so a
    // reviewer reading a failed auto session can see what happened
    // without server-log access.
    onProgress(`⚠ ${msg}`);
    return;
  }
  try {
    const event = JSON.parse(line);
    // Backend-aware event routing (plan.md review F3): Codex turns emit
    // JSONL with a different event schema than Claude's stream-json. The
    // Codex adapter (src/agents/codex-openrouter.js) normalizes them to
    // the same progress vocabulary. Claude turns keep the legacy parser.
    // #3296: an OpenRouter turn run by Claude Code writes Claude stream-json,
    // so only the Codex harness takes this branch.
    if (state.agentBackend === 'codex_openrouter' && state.agentHarness !== 'claude') {
      const codex = require('../agents/codex-openrouter');
      // The normalizer returns an ARRAY of normalized events (a single
      // file_change can emit several changed paths), and it now uses the
      // pinned Codex 0.146.0 JSONL fields exactly. Parsing and state
      // mutation are kept separate so each normalization branch is
      // independently testable.
      const events = codex.normalizeCodexLine(line, state);
      const observeDiagnostics = state.telemetryDiagnosticsEnabled === true;
      for (const ev of events) {
        if (ev.threadId) state.agentThreadId = ev.threadId;
        const isToolStart = ['command_started', 'file_read', 'mcp_started'].includes(ev.kind)
          || (ev.kind === 'file_changed' && ev.lifecycle === 'started');
        const isToolCompletion = ['command_completed', 'file_read_completed', 'mcp_completed'].includes(ev.kind)
          || (ev.kind === 'file_changed' && ev.lifecycle === 'completed');
        if (ev.itemId && (ev.kind === 'command_started' || ev.kind === 'mcp_started')) {
          const open = state.codexOpenTools || (state.codexOpenTools = new Map());
          open.set(ev.itemId, ev.kind === 'command_started'
            ? { kind: 'command', label: ev.text && ev.text.startsWith('$ ') ? ev.text.slice(2) : null }
            : { kind: 'mcp', label: ev.toolName });
        }
        if (ev.itemId && isToolCompletion) state.codexOpenTools?.delete(ev.itemId);
        if (observeDiagnostics && isToolStart) noteCodexToolStart(state, ev);
        if (observeDiagnostics && isToolCompletion) {
          // A future CLI may omit item.started for a completed item. Infer the
          // missing call once from its id so the workload count remains whole.
          if (ev.countCompletion !== false) noteCodexToolStart(state, ev);
          noteCodexToolCompletion(state, ev);
        }
        if (observeDiagnostics && ev.kind === 'file_changed' && ev.lifecycle === 'completed') {
          noteFileChange(state, ev.resourcePath);
        }
        if (observeDiagnostics && ev.diagnostic === 'provider_retry') {
          state.providerRetryCount = (state.providerRetryCount || 0) + 1;
        }
        // Store the final agent message as the turn result (review P4):
        // scout persists this as the spec, and `[done]` (turn.completed)
        // must never overwrite it.
        if (ev.kind === 'agent_message' && ev.fullText != null) {
          if (observeDiagnostics) {
            noteFirstAgentOutput(state);
            state.responseContentBlockCount += 1;
            state.responseTextBlockCount += 1;
            state.responseTextCharacters += String(ev.fullText).length;
          }
          state.lastResultText = ev.fullText;
        } else if (ev.kind === 'usage') {
          // Retain token counts so the Codex turn can be attributed directly
          // to agent_turns (review #3) instead of the Anthropic ledger.
          // Nullish-safe: a missing usage field stays null (absent usage is
          // NOT a genuine zero-token event).
          const u = ev.usage || {};
          if (u.inputTokens != null) state.inputTokens = u.inputTokens;
          if (u.cachedInputTokens != null) state.cachedInputTokens = u.cachedInputTokens;
          if (u.cacheWriteInputTokens != null) state.cacheWriteInputTokens = u.cacheWriteInputTokens;
          if (u.outputTokens != null) state.outputTokens = u.outputTokens;
          if (u.reasoningOutputTokens != null) state.reasoningOutputTokens = u.reasoningOutputTokens;
          // #2870: the Codex/OpenRouter half of the usage seam. Without
          // this the watcher above never hears from this agent at all.
          notifyUsage(state);
        }
        if (ev.kind === 'error' && ev.errorMessage != null) {
          state.ccIsError = true;
          state.agentError = ev.errorMessage;
          // The normalizer already decided what kind of provider failure
          // this is. Carrying its verdict beats re-deriving one from the
          // message text further downstream, where less is known.
          if (ev.errorCode) state.agentErrorCode = ev.errorCode;
          if (ev.requestedOutputTokens != null) {
            state.requestedOutputTokens = ev.requestedOutputTokens;
          }
          if (ev.affordableOutputTokens != null) {
            state.affordableOutputTokens = ev.affordableOutputTokens;
          }
        }
        // Progress line: use the short display form (or any event text).
        if (ev.text) onProgress(ev.text);
      }
    } else {
      applyStreamEvent(event, onProgress, state);
    }
  } catch {
    // Plain log line (git output, shell echo, etc.).
    if (line.length < 500) onProgress(line);
  }
}

function newWatchState() {
  return {
    // Stable logical turn identity used by cleanup/spend idempotency. This is
    // host-owned and never parsed from untrusted runner output.
    turnId: null,
    lastResultText: '',
    costUsd: 0,
    liveSpend: liveAgentSpend.createTracker(),
    liveSpendEnabled: false,
    // Claude's result event is the evidence that a zero cost is known rather
    // than the legacy state default. Telemetry reads this flag only; billing
    // continues to consume costUsd exactly as before.
    providerCostSeen: false,
    // Set only after docker accepted the detached provider process. Codex's
    // ledger intent exists before that boundary, so the aggregate report
    // needs this evidence to exclude a stop/failure during spin-up.
    providerDispatched: false,
    // Retained terminal-result usage. Codex persists these values to
    // agent_turns; Claude telemetry records the same nullable fields from its
    // final result event. Missing provider usage remains null.
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    sessionId: null,
    initSessionId: null,
    // Host-side identity, seeded by whoever builds the state. Distinct from
    // `sessionId` above, which is the PROVIDER's session id parsed out of the
    // runner's own events. Only used to give runner warnings a context object
    // in the platform log — a bare `log.warn('worker', msg)` produced
    // `"data": null` entries that named no session and no container.
    hostSessionId: null,
    hostContainerName: null,
    ccIsError: false,
    agentError: null,
    // Set from the Codex normalizer's classification of a provider failure
    // (see src/agents/codex-openrouter.js). Null for every other backend and
    // for a turn that never failed.
    agentErrorCode: null,
    requestedOutputTokens: null,
    // Last HTTP request observed by the worker-local OpenRouter adapter.
    // Only content-free fields are accepted by the Codex normalizer.
    providerRequest: null,
    // #3038: the per-turn sum of each model request's usage as the adapter
    // saw it finish. Survives a stop, unlike the agent's own totals, which
    // arrive only at turn.completed. A floor: an in-flight request is missing.
    relayUsage: null,
    // The output-token budget OpenRouter said the key could afford, when it
    // said so. Drives the one clamped retry in the sessions attempt loop.
    affordableOutputTokens: null,
    usageSeen: false,
    resultSubtype: null,
    providerStopReason: null,
    telemetryDiagnosticsEnabled: false,
    // Content-free workload and latency diagnostics. Counters start at zero
    // because the JSONL parser sees the complete run; provider-reported
    // values override them when the terminal result has a more authoritative
    // aggregate (for example Claude's num_turns).
    providerStartedMs: null,
    providerDurationMs: null,
    agentReportedDurationMs: null,
    queueDurationMs: null,
    dispatchSetupDurationMs: null,
    timeToFirstOutputMs: null,
    modelContextWindowTokens: null,
    modelMaxOutputTokens: null,
    cacheWrite5mInputTokens: null,
    cacheWrite1hInputTokens: null,
    serverWebSearchCount: null,
    serverWebFetchCount: null,
    serviceTier: null,
    inferenceRegion: null,
    providerTurnCount: null,
    providerModelCount: null,
    providerRetryCount: null,
    providerRateLimitEventCount: null,
    contextCompactionCount: null,
    contextCompactionPreTokensMax: null,
    responseContentBlockCount: 0,
    responseTextBlockCount: 0,
    responseTextCharacters: 0,
    responseToolCallCount: 0,
    responseServerToolCallCount: 0,
    responseThinkingBlockCount: 0,
    responseThinkingCharacters: 0,
    responseRedactedThinkingBlockCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    permissionDenialCount: 0,
    commandCount: 0,
    fileReadCount: 0,
    fileSearchCount: 0,
    fileChangeCount: 0,
    mcpCallCount: 0,
    subagentCallCount: 0,
    webToolCallCount: 0,
    toolSearchCount: 0,
    requestMode: null,
    requestMessageCount: null,
    requestUserMessageCount: null,
    requestContentBlockCount: null,
    requestTextCharacters: null,
    requestUserTextCharacters: null,
    requestAssistantTextCharacters: null,
    requestToolResultTextCharacters: null,
    requestThinkingCharacters: null,
    requestPayloadCharacters: null,
    requestSystemCharacters: null,
    requestToolDefinitionCount: null,
    requestMcpServerCount: null,
    requestAgentDefinitionCount: null,
    requestSkillCount: null,
    requestPluginCount: null,
    // plan.md 5.6: missing usage stays null, never a false zero.
    cacheWriteInputTokens: null,
    ccExit: null,
    // Backend-neutral terminal-result fields (plan.md §4-PR1). PR5's
    // codex_openrouter runner emits these; claude_code leaves them null
    // and callers keep using ccExit/cc_session_id during migration.
    agentBackend: null,
    agentProvider: null,
    agentModel: null,
    agentThreadId: null,
    agentExit: null,
    // Runner-to-host control signal: a stale/missing resume thread needs
    // one fresh physical dispatch, accounted as a separate attempt.
    agentRetryFresh: false,
    ahead: 0,
    // #8: how many commits the branch is behind origin/main, parsed from
    // run-cc.sh's __USERNODE_RESULT__ line. Persisted to
    // chat_sessions.behind_main on every turn so the dev-chat banner
    // and merge-time block always reflect the latest state.
    behind: 0,
    sha: null,
    pushOk: false,
    // #8: clean|resolved|conflict|already_synced (MODE=sync only). The
    // route handler routes the chat message off this.
    syncResult: null,
    // #361: conflicted file paths from a MODE=sync turn's
    // __USERNODE_RESULT__ line. Defaults empty.
    conflictFiles: [],
    phase: null,
    fatalError: null,
    resultSeen: false,
    // True once the detached-exec wrapper's __USERNODE_EXIT__ line has
    // been parsed from the turn journal (detached transport only).
    execExitSeen: false,
    // Why a markerless turn (exitCode -1, no __USERNODE_EXIT__ line) was
    // declared dead: 'container_gone' | 'oom_killed' |
    // 'probe_unobservable' | 'turn_process_gone'. Null for turns that
    // ended with a marker. Routes use this for cause-specific failure
    // messages instead of a bare "-1".
    markerlessCause: null,
    rawStdout: '',
    rawStderr: '',
    exitCode: null,
    // id → { name, label } for pending tool_use calls, so the matching
    // tool_result can be annotated with the same label.
    toolUses: new Map(),
    // Runtime-only sets provide deduplication and distinct counts. Their raw
    // names/paths never cross the telemetry allowlist or enter its ledger.
    telemetryStartedItemIds: new Set(),
    telemetryCompletedItemIds: new Set(),
    telemetryToolNames: new Set(),
    telemetryFileReads: new Set(),
    telemetryFileChanges: new Set(),
  };
}

function codingRunOutcome(state) {
  if (state && (state.exitCode === 143 || state.agentExit === 143 || state.ccExit === 143)) {
    return { outcome: 'cancelled', stopReason: 'cancelled' };
  }
  const failed = !state || !!(state.fatalError || state.ccIsError
    || (state.agentExit != null && state.agentExit !== 0)
    || (state.ccExit != null && state.ccExit !== 0)
    || (state.exitCode != null && state.exitCode !== 0));
  if (!failed) return {
    outcome: 'success',
    stopReason: (state && state.providerStopReason) || 'end_turn',
  };
  if (state && state.markerlessCause) {
    return { outcome: 'error', stopReason: `markerless_${state.markerlessCause}` };
  }
  if (state && state.resultSubtype && state.resultSubtype !== 'success') {
    return {
      outcome: 'error',
      stopReason: state.providerStopReason || state.resultSubtype,
    };
  }
  if (state && state.agentRetryFresh) {
    return { outcome: 'error', stopReason: 'resume_thread_missing' };
  }
  if (state && state.agentExit != null && state.agentExit !== 0) {
    return { outcome: 'error', stopReason: 'agent_exit_nonzero' };
  }
  if (state && state.ccExit != null && state.ccExit !== 0) {
    return { outcome: 'error', stopReason: 'claude_exit_nonzero' };
  }
  if (state && state.exitCode != null && state.exitCode !== 0) {
    return { outcome: 'error', stopReason: 'worker_exit_nonzero' };
  }
  return { outcome: 'error', stopReason: 'agent_error' };
}

// A provider failure the Codex normalizer already classified reports that
// classification. The substring table below is the fallback for backends and
// failures that carry no code, and it guesses: an OpenRouter credit refusal
// mentioning "connection" used to land on 'network' rather than 'billing'.
const CODEX_ERROR_CLASSES = {
  insufficient_credits: 'billing',
  insufficient_credits_max_tokens: 'billing',
  rate_limited: 'rate_limited',
  credential_failure: 'authentication',
  stream_disconnected: 'network',
};

function codingErrorClass(state, outcome) {
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome !== 'error') return null;
  if (state && state.markerlessCause) return 'worker';
  const classified = state && CODEX_ERROR_CLASSES[state.agentErrorCode];
  if (classified) return classified;
  const text = String([
    state && state.resultSubtype,
    state && state.agentError,
    state && state.fatalError,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (/429|rate.?limit/.test(text)) return 'rate_limited';
  if (/timeout|timed.?out|etimedout/.test(text)) return 'timeout';
  if (/401|unauthori[sz]ed|authentication|api.?key/.test(text)) return 'authentication';
  if (/402|credit|payment|billing/.test(text)) return 'billing';
  if (/403|permission|denied/.test(text)) return 'permission';
  if (/overload|529/.test(text)) return 'overloaded';
  if (/network|connection|econn|socket/.test(text)) return 'network';
  if (state && (state.fatalError
      || (state.exitCode != null && Number(state.exitCode) !== 0))) return 'worker';
  return 'provider';
}

function claudeBillingPath({ directByok, byokCents, costUsd }) {
  if (directByok) return 'anthropic_byok';
  const observedByok = Number(byokCents || 0);
  if (observedByok <= 0) return 'platform';
  const totalCents = Number(costUsd) * 100;
  if (Number.isFinite(totalCents) && totalCents > 0
      && observedByok >= totalCents - 0.5) return 'anthropic_byok';
  if (Number.isFinite(totalCents) && totalCents > 0) {
    // A proxy-routed run can cross the allowance boundary mid-turn. Keep the
    // provider-reported total intact while naming the two-payer path instead
    // of presenting a known mixed run as missing attribution.
    return 'anthropic_mixed';
  }
  return 'unknown';
}

function recordClaudeCodingRun({
  sessionId, turnId, result, requestedModel, component, startedAt, durationMs,
  directByok = false, byokCents = 0, attemptNumber = 1, correlationId = null,
}) {
  if (!component || !turnId) return;
  const { outcome, stopReason } = codingRunOutcome(result);
  const knownCost = Number(result && result.costUsd);
  const costWasReported = !!(result && result.providerCostSeen)
    || (Number.isFinite(knownCost) && knownCost > 0);
  const costUsd = costWasReported && Number.isFinite(knownCost) && knownCost >= 0
    ? knownCost
    : null;
  void llmTelemetry.record(_getPoolSafe(), {
    invocationKey: `claude_code:${turnId}`,
    timestamp: startedAt,
    sessionId,
    provider: 'anthropic',
    backend: 'coding_agent',
    component,
    requestedModel,
    servedModel: (result && result.agentModel) || requestedModel || null,
    billingPath: claudeBillingPath({ directByok, byokCents, costUsd }),
    // Current Claude result events expose aggregate run usage. Older or
    // partial result shapes keep these fields null; no values are inferred
    // from cost or duration.
    inputTokens: result && result.inputTokens,
    cacheReadInputTokens: result && result.cachedInputTokens,
    cacheWriteInputTokens: result && result.cacheWriteInputTokens,
    outputTokens: result && result.outputTokens,
    reasoningOutputTokens: result && result.reasoningOutputTokens,
    cacheWrite5mInputTokens: result && result.cacheWrite5mInputTokens,
    cacheWrite1hInputTokens: result && result.cacheWrite1hInputTokens,
    serverWebSearchCount: result && result.serverWebSearchCount,
    serverWebFetchCount: result && result.serverWebFetchCount,
    serviceTier: result && result.serviceTier,
    inferenceRegion: result && result.inferenceRegion,
    requestMode: result && result.requestMode,
    requestMessageCount: result && result.requestMessageCount,
    requestUserMessageCount: result && result.requestUserMessageCount,
    requestContentBlockCount: result && result.requestContentBlockCount,
    requestTextCharacters: result && result.requestTextCharacters,
    requestUserTextCharacters: result && result.requestUserTextCharacters,
    requestAssistantTextCharacters: result && result.requestAssistantTextCharacters,
    requestToolResultTextCharacters: result && result.requestToolResultTextCharacters,
    requestThinkingCharacters: result && result.requestThinkingCharacters,
    requestPayloadCharacters: result && result.requestPayloadCharacters,
    requestSystemCharacters: result && result.requestSystemCharacters,
    requestToolDefinitionCount: result && result.requestToolDefinitionCount,
    requestMcpServerCount: result && result.requestMcpServerCount,
    requestAgentDefinitionCount: result && result.requestAgentDefinitionCount,
    requestSkillCount: result && result.requestSkillCount,
    requestPluginCount: result && result.requestPluginCount,
    providerDurationMs: result && result.providerDurationMs,
    agentReportedDurationMs: result && result.agentReportedDurationMs,
    queueDurationMs: result && result.queueDurationMs,
    dispatchSetupDurationMs: result && result.dispatchSetupDurationMs,
    timeToFirstOutputMs: result && result.timeToFirstOutputMs,
    modelContextWindowTokens: result && result.modelContextWindowTokens,
    modelMaxOutputTokens: result && result.modelMaxOutputTokens,
    providerTurnCount: result && result.providerTurnCount,
    providerModelCount: result && result.providerModelCount,
    providerRetryCount: result && result.providerRetryCount,
    providerRateLimitEventCount: result && result.providerRateLimitEventCount,
    contextCompactionCount: result && result.contextCompactionCount,
    contextCompactionPreTokensMax: result && result.contextCompactionPreTokensMax,
    responseContentBlockCount: result && result.responseContentBlockCount,
    responseTextBlockCount: result && result.responseTextBlockCount,
    responseTextCharacters: result && result.responseTextCharacters,
    responseToolCallCount: result && result.responseToolCallCount,
    responseServerToolCallCount: result && result.responseServerToolCallCount,
    responseThinkingBlockCount: result && result.responseThinkingBlockCount,
    responseThinkingCharacters: result && result.responseThinkingCharacters,
    responseRedactedThinkingBlockCount: result && result.responseRedactedThinkingBlockCount,
    toolCallCount: result && result.toolCallCount,
    toolResultCount: result && result.toolResultCount,
    toolErrorCount: result && result.toolErrorCount,
    distinctToolCount: result && result.telemetryToolNames instanceof Set
      ? result.telemetryToolNames.size
      : null,
    permissionDenialCount: result && result.permissionDenialCount,
    commandCount: result && result.commandCount,
    fileReadCount: result && result.fileReadCount,
    distinctFileReadCount: result && result.telemetryFileReads instanceof Set
      ? result.telemetryFileReads.size
      : null,
    fileSearchCount: result && result.fileSearchCount,
    fileChangeCount: result && result.fileChangeCount,
    distinctFileChangeCount: result && result.telemetryFileChanges instanceof Set
      ? result.telemetryFileChanges.size
      : null,
    mcpCallCount: result && result.mcpCallCount,
    subagentCallCount: result && result.subagentCallCount,
    webToolCallCount: result && result.webToolCallCount,
    toolSearchCount: result && result.toolSearchCount,
    costUsd,
    costSource: costUsd == null ? 'unavailable' : 'provider_reported',
    durationMs,
    outcome,
    stopReason,
    errorClass: codingErrorClass(result, outcome),
    attemptNumber,
    correlationId: correlationId || String(turnId),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Image build
// ──────────────────────────────────────────────────────────────────────

async function ensureWorkerImage() {
  // Self-previews serve requests only; image builds belong to their parent.
  if (process.env.USERNODE_ENV === 'staging') return;
  if (usesKubernetesWorkers()) {
    if (!(process.env.KUBERNETES_WORKER_IMAGE || '').includes('@sha256:')) {
      throw new Error('KUBERNETES_WORKER_IMAGE must be configured with an immutable digest');
    }
    return;
  }
  // Always build; Docker's layer cache makes this fast when nothing's
  // changed, and crucially picks up edits to worker-run.sh / run-cc.sh
  // without requiring a manual `docker rmi`.
  //
  // CLAUDE_CODE_CACHE_BUST (today's UTC date) busts the
  // `npm install -g @anthropic-ai/claude-code` layer once per calendar
  // day so the worker tracks the latest CLI. Without this, that layer is
  // cached indefinitely and the worker freezes at a stale CLI version —
  // newer models (Sonnet 5 / Opus 4.8) then 400 with
  // "thinking.type.enabled is not supported for this model" because the
  // old CLI emits the legacy thinking shape. Day-granular so steady-state
  // session bootstraps stay cache-fast (no per-session npm reinstall).
  const path = require('path');
  const workerDir = path.join(__dirname, '../../worker');
  const cacheBust = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  log.info('worker', 'Building worker image', { dir: workerDir, cacheBust });
  await docker.buildImage(workerDir, WORKER_IMAGE, {
    CLAUDE_CODE_CACHE_BUST: cacheBust,
  });
}

// Docker-volume name used to persist Claude Code's on-disk session
// memory (~/.claude) for a given chat session. Reused across every
// turn — and across container churn (eviction + re-warm) — of the
// same chat so `--resume <cc_session_id>` can replay context from disk.
function ccVolumeName(sessionId) {
  return `usernode-cc-${sessionId}`;
}

function workerContainerName(sessionId) {
  return `usernode-worker-${sessionId}`;
}

// Runtime object name for a session worker. Keep the Docker name stable for
// single-server installs, while Kubernetes callers address the Deployment /
// Pod through the name used by kubernetes.ensureWorker().
function workerRuntimeName(sessionId) {
  return usesKubernetesWorkers()
    ? kubernetes.dnsName(`sv-worker-s${sessionId}`)
    : workerContainerName(sessionId);
}

// Per-turn journal file inside the CC volume (/home/node/.claude). The
// detached `docker exec` wrapper redirects run-cc.sh's combined output
// here so the turn's progress stream survives a platform restart: the
// volume outlives both the exec and the platform process, and the boot
// adoption path can replay the file from line 0 to pick the turn back
// up. One turn per session is in flight at a time (enforced via the
// warm registry), so the timestamp suffix only disambiguates the
// current turn from stale leftovers (which the wrapper rm's first).
function turnJournalPath(turnId) {
  return turnLifecycle.journalPathForAttempt(turnId);
}

// Per-turn prompt file inside the CC volume. The dispatch prompt used to
// travel as a `docker exec -e PROMPT=<value>` argument, but Linux caps a
// single argv/env string at 128 KiB (MAX_ARG_STRLEN) — a session with a
// large spec doc pushed the build prompt past the cap and every dispatch
// died with `spawn E2BIG` before the exec existed (prod session 2538).
// The prompt is now materialized here via stdin (base64-inlined, so it
// never rides argv/env) and run-cc.sh pipes it to the claude CLI from
// disk. Lives outside the repo checkout, so `git add -A` can't commit
// it; the detached wrapper rm's it when the turn ends.
const TURN_PROMPT_PATH = '/home/node/.claude/turn-prompt.txt';
// Hosted Claude build turns load the platform handbook from this separate
// appended-system-prompt file. Keeping it out of TURN_PROMPT_PATH prevents a
// resumed conversation from accumulating another ~130 KB user message every
// turn, while Claude Code still re-applies the current rules after compaction.
const TURN_SYSTEM_PROMPT_PATH = '/home/node/.claude/turn-system-prompt.txt';
// A resumed hosted-Claude build may omit a spec that is already the preceding
// assistant response in that exact Claude conversation. If --resume is stale,
// run-cc.sh retries without conversation history and must use this complete
// user-level prompt instead. Keeping the fallback separate preserves both the
// context saving on resume and the old fully-specified fresh-run behavior.
const TURN_RESUME_FALLBACK_PROMPT_PATH = '/home/node/.claude/turn-resume-fallback-prompt.txt';

// Shell script that writes arbitrary turn context to a fixed private path.
// The base64
// payload is split into bounded chunks appended by `printf` (a shell
// builtin — no exec, so no MAX_ARG_STRLEN exposure) so the script works
// for prompts of any size regardless of the container shell's line
// handling. Pure — exported for unit tests.
const PROMPT_B64_CHUNK = 64 * 1024;
function buildTurnContextFileScript(content, targetPath) {
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const lines = [
    'set -e',
    'mkdir -p /home/node/.claude',
    `: > ${targetPath}.b64`,
  ];
  for (let i = 0; i < b64.length; i += PROMPT_B64_CHUNK) {
    lines.push(`printf '%s' '${b64.slice(i, i + PROMPT_B64_CHUNK)}' >> ${targetPath}.b64`);
  }
  lines.push(`base64 -d < ${targetPath}.b64 > ${targetPath}`);
  lines.push(`rm -f ${targetPath}.b64`);
  return lines.join('\n') + '\n';
}

function buildTurnPromptScript(prompt) {
  return buildTurnContextFileScript(prompt, TURN_PROMPT_PATH);
}

function buildTurnSystemPromptScript(systemPrompt) {
  return buildTurnContextFileScript(systemPrompt, TURN_SYSTEM_PROMPT_PATH);
}

function buildTurnResumeFallbackPromptScript(prompt) {
  return buildTurnContextFileScript(prompt, TURN_RESUME_FALLBACK_PROMPT_PATH);
}

// Materialize the dispatch prompt into the warm worker's CC volume ahead
// of the detached exec. Unlike syncUserAgentFiles this file is required:
// a failure here fails the turn (before active_turn is persisted, so
// there is nothing to clean up).
async function writeTurnPrompt(sessionId, prompt) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`writeTurnPrompt: no warm worker registered for session ${sessionId}`);
  }
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(meta.containerName, ['sh', '-s'], buildTurnPromptScript(prompt));
  } else {
    await docker.execShellStdin(meta.containerName, buildTurnPromptScript(prompt), {
      timeoutMs: 20000, label: 'writeTurnPrompt',
    });
  }
}

// Required companion to writeTurnPrompt for hosted Claude builds. A failure
// aborts before active_turn is persisted or the provider is dispatched; the
// platform must never silently run a shortened task prompt without its
// authoritative conventions.
async function writeTurnSystemPrompt(sessionId, systemPrompt) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`writeTurnSystemPrompt: no warm worker registered for session ${sessionId}`);
  }
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(
      meta.containerName,
      ['sh', '-s'],
      buildTurnSystemPromptScript(systemPrompt),
    );
  } else {
    await docker.execShellStdin(meta.containerName, buildTurnSystemPromptScript(systemPrompt), {
      timeoutMs: 20000, label: 'writeTurnSystemPrompt',
    });
  }
}

// Complete user-level prompt used only when a hosted Claude --resume attempt
// fails and run-cc.sh retries fresh. It is required whenever supplied: failing
// to materialize it aborts before dispatch rather than running without the
// session's authoritative spec.
async function writeTurnResumeFallbackPrompt(sessionId, prompt) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`writeTurnResumeFallbackPrompt: no warm worker registered for session ${sessionId}`);
  }
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(
      meta.containerName,
      ['sh', '-s'],
      buildTurnResumeFallbackPromptScript(prompt),
    );
  } else {
    await docker.execShellStdin(
      meta.containerName,
      buildTurnResumeFallbackPromptScript(prompt),
      { timeoutMs: 20000, label: 'writeTurnResumeFallbackPrompt' },
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Durable turn records (chat_sessions.active_turn)
// ──────────────────────────────────────────────────────────────────────
//
// Written before the detached dispatch and cleared when the journal has
// been consumed to completion. If the platform dies mid-turn the record
// survives, and server.js's adoption path resumes the turn from its
// journal instead of killing the in-container claude.
//
// The pool singleton is created by server.js at boot, long before any
// turn can run, so the bare getPool() here never constructs.
function _getPoolSafe() {
  try {
    return require('../db/pool').getPool();
  } catch {
    return null;
  }
}

async function _persistActiveTurn(sessionId, turn) {
  const pool = _getPoolSafe();
  if (!pool) return false;
  try {
    const current = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (current) {
      // Codex registers the ledger row and dispatch intent atomically before
      // entering execInWorker. Accept only that exact physical attempt; this
      // function is not allowed to replace an earlier attempt merely because
      // it shares a logical turn id.
      const isRegisteredAttempt = !!(
        turn.backend === 'codex_openrouter'
        && current.backend === 'codex_openrouter'
        && turn.turnUuid
        && String(current.turnUuid || '') === String(turn.turnUuid)
        && String(turnLifecycle.turnIdentity(current) || '') === String(turn.turnId || '')
        && current.phase === turnLifecycle.PHASE_DISPATCH_PENDING
        && String(current.journal || '') === String(turn.journal || '')
      );
      if (isRegisteredAttempt) return true;
      const err = new Error('turn-lifecycle: session already owns a different turn');
      err.code = 'session_busy';
      throw err;
    }
    await turnLifecycle.persistNewTurn(pool, sessionId, turn);
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to persist active_turn', { sessionId, err: err.message });
    return false;
  }
}

async function clearActiveTurn(sessionId, { turnId = null, journal = null } = {}) {
  const pool = _getPoolSafe();
  if (!pool) return false;
  try {
    if (!turnId && !journal) {
      const err = new Error('clearActiveTurn: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    await turnLifecycle.markCleanupPending(pool, { sessionId, turnId, journal });
    await turnLifecycle.clearCleanupPending(pool, { sessionId, turnId, journal });
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to clear active_turn', { sessionId, err: err.message });
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Post-agent TAIL: keeping the turn record alive past the exec
// ──────────────────────────────────────────────────────────────────────
//
// A dispatch turn has TWO halves and only the first one used to be
// durable:
//
//   1. the exec — `claude` running in the worker, journalled to disk;
//   2. the TAIL — everything the platform does afterwards: heal the
//      push, open/update the PR, build the staging preview, capture
//      visuals, post the "Claude Code finished" card, and re-issue the
//      Mayor's wrap-up.
//
// The tail is minutes long (a self-app staging build alone spends ~4:45
// cloning the platform DB) and ran with `active_turn` ALREADY cleared,
// so a restart inside it was invisible to boot adoption: the container
// had no live exec, adoptOrphanWorker took its warm-idle branch, and the
// chat froze on "Building staging preview..." forever (session 2954).
//
// So callers that own a tail pass `holdTurnRecord: true` to
// execInWorker. Instead of clearing the record when the journal is
// consumed, it stamps `phase: 'tail_pending'` and KEEPS the journal file — which
// is exactly what resumeDetachedTurn needs to replay the turn and run
// finalizeRecoveredTurn on the next boot. The owner calls finishTurn() only
// at its explicit completion boundary; a thrown tail deliberately keeps it.
//
// `tail` on the record is the milestone map: which tail steps already
// landed, so a resumed tail redoes none of them (see noteTailMilestone).
const TURN_PHASE_TAIL = turnLifecycle.PHASE_TAIL_PENDING;

async function markTurnTail(sessionId, milestones = {}, { turnId = null, journal = null } = {}) {
  const pool = _getPoolSafe();
  if (!pool) throw new Error('markTurnTail: database pool unavailable');
  const meta = _registryGet(sessionId);
  let identity = turnId || meta?.finishedTurnId || null;
  let recoveryJournal = journal || meta?.finishedJournal || null;
  try {
    if (!identity && !recoveryJournal) {
      const err = new Error('markTurnTail: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    await turnLifecycle.markTailPending(pool, {
      sessionId,
      turnId: identity,
      journal: recoveryJournal,
      patch: { tail: milestones || {} },
    });
    return true;
  } catch (err) {
    log.warn('worker', 'Failed to mark active_turn tail', { sessionId, err: err.message });
    throw err;
  }
}

// Record ONE tail milestone on the held record (merge, never replace).
// No-op when the record is already gone — a stamp arriving after finishTurn
// must not resurrect it. Every live/recovered caller supplies either its
// explicit identity or the identity remembered by execInWorker; there is no
// session-only mutation fallback.
async function noteTailMilestone(sessionId, milestones, { turnId = null, journal = null } = {}) {
  if (!milestones || typeof milestones !== 'object') return false;
  const pool = _getPoolSafe();
  if (!pool) throw new Error('noteTailMilestone: database pool unavailable');
  const meta = _registryGet(sessionId);
  const identity = turnId || meta?.finishedTurnId || null;
  const recoveryJournal = journal || meta?.finishedJournal || null;
  try {
    if (!identity && !recoveryJournal) {
      const err = new Error('noteTailMilestone: durable turn identity required');
      err.code = 'turn_identity_required';
      throw err;
    }
    const result = await turnLifecycle.mergeTailMilestones(pool, {
      sessionId,
      turnId: identity,
      journal: identity ? null : recoveryJournal,
      milestones,
    });
    return result.updated;
  } catch (err) {
    log.warn('worker', 'Failed to note tail milestone', { sessionId, err: err.message });
    throw err;
  }
}

// Mark a completed missing-thread attempt as prepared for the one allowed
// live retry. Preparation remains a tail_pending state: only the atomic
// startCodexAttempt transaction may advance the durable record back to
// dispatch_pending with attempt two's ledger identity.
async function markTurnRetryPending(sessionId, {
  turnUuid, logicalTurnId, attemptNumber = 1,
} = {}) {
  const pool = _getPoolSafe();
  if (!pool) throw new Error('markTurnRetryPending: database pool unavailable');
  await turnLifecycle.transitionTurn(pool, {
    sessionId,
    turnId: logicalTurnId,
    turnUuid,
    from: [turnLifecycle.PHASE_TAIL_PENDING, 'tail', 'retry_pending'],
    to: turnLifecycle.PHASE_TAIL_PENDING,
    patch: {
      retryFresh: true,
      logicalTurnId,
      attemptNumber,
      retryPreparedAt: new Date().toISOString(),
    },
  });
  return true;
}

// End of the whole turn (exec + tail): drop the durable record and the
// journal it pointed at. This is what execInWorker's `finally` does for
// callers that DON'T hold the record; holders call it themselves when
// their tail finishes (or dies). Idempotent — safe to call twice, and
// safe to call for a turn that never held a record.
// Is this active_turn record a held TAIL (the exec is over, the platform
// side is not)? Pure so server.js's adoption branches and their tests can
// classify a row without a pool. Tolerates a string-encoded jsonb column.
function isTailPhase(activeTurn) {
  if (!activeTurn) return false;
  let rec = activeTurn;
  if (typeof rec === 'string') {
    try { rec = JSON.parse(rec); } catch { return false; }
  }
  return !!rec && (rec.phase === TURN_PHASE_TAIL || rec.phase === 'tail');
}

async function finishTurn(sessionId, { journal = null, turnId = null } = {}) {
  const meta = _registryGet(sessionId);
  const rememberedJournal = meta?.finishedJournal || null;
  const rememberedTurnId = meta?.finishedTurnId || null;
  const journalPaths = new Set([journal, rememberedJournal].filter(Boolean));
  const pool = _getPoolSafe();
  if (!pool) return false;
  let ownsCleanup = false;
  let cleanupTurnId = null;
  let cleanupJournal = null;
  try {
    const current = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (current) {
      // Never infer ownership from the record currently occupying the
      // session. A stale caller may be looking at a replacement turn; only
      // the identity it carried (or execInWorker remembered for it) can clear.
      if (turnId) cleanupTurnId = turnId;
      else if (journal) cleanupJournal = journal;
      else if (rememberedTurnId) cleanupTurnId = rememberedTurnId;
      else if (rememberedJournal) cleanupJournal = rememberedJournal;
      if (!cleanupTurnId && !cleanupJournal) {
        const err = new Error('finishTurn: durable turn identity required');
        err.code = 'turn_identity_required';
        throw err;
      }
      const cleanup = await turnLifecycle.markCleanupPending(pool, {
        sessionId,
        turnId: cleanupTurnId,
        journal: cleanupJournal,
      });
      ownsCleanup = !cleanup.alreadyCleared;
      if (ownsCleanup && current.journal) journalPaths.add(current.journal);
    }
  } catch (err) {
    log.warn('worker', 'Turn cleanup deferred because active_turn could not be cleared', {
      sessionId, journalCount: journalPaths.size, err: err.message,
    });
    return false;
  }

  // Keep cleanup_pending durable while removing the shared prompt. If the
  // row were cleared first, a replacement dispatch could write its prompt
  // in the gap and this stale cleanup would delete the new turn's input.
  // An idempotent call after the row is already gone may remove only UUID-
  // unique journals; it never owns the shared prompt path.
  const filesToRemove = [...journalPaths];
  if (ownsCleanup) filesToRemove.push(
    TURN_PROMPT_PATH,
    TURN_SYSTEM_PROMPT_PATH,
    TURN_RESUME_FALLBACK_PROMPT_PATH,
  );
  if (filesToRemove.length) {
    const containerName = _registryGet(sessionId)?.containerName
      || workerRuntimeName(sessionId);
    await execWorkerCommand(containerName, ['rm', '-f', ...filesToRemove], null, { timeoutMs: 5000 }).catch(() => {});
  }

  if (ownsCleanup) {
    try {
      await turnLifecycle.clearCleanupPending(pool, {
        sessionId,
        turnId: cleanupTurnId,
        journal: cleanupJournal,
      });
    } catch (err) {
      log.warn('worker', 'Turn cleanup deferred because active_turn could not be cleared', {
        sessionId, journalCount: journalPaths.size, err: err.message,
      });
      return false;
    }
  }
  _registryUpsert(sessionId, { finishedJournal: null, finishedTurnId: null });
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Warm-worker registry
// ──────────────────────────────────────────────────────────────────────
//
// Long-lived per-session worker containers are tracked here so the host
// knows which sessions have a warm container ready to take execs, when
// each was last used (for idle eviction), and whether one is currently
// running a `docker exec` (for stop semantics + drain).
//
// Shape: Map<sessionId:number, {
//   containerName: string,
//   lastUsedMs:    number,    // updated when an exec completes / on adopt
//   inFlight:      boolean,   // true while a docker-exec child is running
//   bootstrap:     Promise|null,   // present while ensureWorker is racing
//   adopted:       boolean,   // true if registered via adoptWarmWorker
// }>
//
// Lifecycle:
//   - ensureWorker()    → creates entry on first use, awaits bootstrap.
//   - execInWorker()    → toggles inFlight + bumps lastUsedMs on finish.
//   - evictWorker()     → docker stop+rm, deletes entry. Volume kept.
//   - destroyWorker()   → also deletes the entry (compat path used by
//                         legacy adoption + session archive).
//   - adoptWarmWorker() → server restart picked up an existing warm
//                         container; register it so the next exec
//                         doesn't try to re-bootstrap on top.
const _warmRegistry = new Map();

function _registryGet(sessionId) {
  return _warmRegistry.get(sessionId) || null;
}

function _registryUpsert(sessionId, patch) {
  const existing = _warmRegistry.get(sessionId);
  const prev = existing || {
    containerName: workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: false,
  };
  const next = { ...prev, ...patch };
  _warmRegistry.set(sessionId, next);
  // #1038: the inner docker-exec window is one of the two signals
  // isSessionBusy() ORs together, so a change here can flip a session's
  // working state for every client. Only the actual transition notifies —
  // lastUsedMs bumps and bootstrap bookkeeping are invisible to clients.
  if (!!prev.inFlight !== !!next.inFlight) {
    try {
      require('./active-workers').notifySessionState(sessionId);
    } catch { /* notifier is best-effort */ }
  }
  return next;
}

// Cheap "is this session's worker actively running CC right now?" check.
// Mirrors the in-process `inFlight` flag set by execInWorker. A warm-but-
// idle container (sleep wrapper alive, no `docker exec` running)  → false.
// Returns false when no warm registry entry exists at all (no worker
// ever started, or the entry was evicted).
//
// Use this — NOT `containerStatus === 'running'` — anywhere you need to
// gate logic on "a CC turn is in progress for this session". The
// container-status check predates `keep cc warm between calls` and now
// over-reports busy for the entire warm-idle window (~10 min until the
// sweeper evicts), which strands the dev-chat UI in stop-sign mode if
// the POST SSE drops before delivering its `done` event.
function isInFlight(sessionId) {
  return _warmRegistry.get(sessionId)?.inFlight === true;
}

// Read-only snapshot of the warm registry. Safe to expose to the idle-
// eviction sweeper and the /api/status admin page.
function warmRegistrySnapshot() {
  const out = [];
  for (const [sessionId, meta] of _warmRegistry.entries()) {
    out.push({
      sessionId,
      containerName: meta.containerName,
      lastUsedMs: meta.lastUsedMs,
      inFlight: meta.inFlight,
      bootstrapping: !!meta.bootstrap,
      adopted: !!meta.adopted,
      // #889: a stop has been signalled for this worker's turn but the turn
      // hasn't unwound yet. Additive diagnostics — same spirit as inFlight —
      // and it's what makes the flag observable without exporting internals.
      stopRequestedAt: meta.stopRequestedAt || null,
    });
  }
  return out;
}

// Register a warm container that already exists (either spawned by us
// earlier in this process, or adopted from a previous server run).
function adoptWarmWorker(sessionId, containerName = null) {
  _registryUpsert(sessionId, {
    containerName: containerName || workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: true,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Bootstrap (cold start) + warm-ready wait
// ──────────────────────────────────────────────────────────────────────

// How many non-marker bootstrap lines to keep for the failure report.
const BOOTSTRAP_LOG_LINES = 20;
// How many `docker logs` lines to harvest off a container that failed to
// reach warm-ready, before anything reaps it.
const BOOTSTRAP_LOG_TAIL = 50;
// Cold bootstrap is a network operation against github.com from a
// just-created network namespace, and it fails transiently. Three attempts
// with a short jittered backoff; see isRetryableBootstrapError for what
// actually qualifies.
const BOOTSTRAP_MAX_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_BASE_MS = 500;

// Stable, machine-matchable prefixes. `die` in worker-run.sh emits
// "clone failed: <git stderr>" / "checkout failed: <git stderr>" and
// _awaitWarmReady rejects with "warm-ready timeout for <name>" or
// "warm wrapper exited before warm-ready (code=N)".
//
// Classification is by PREFIX and never by the text after the colon: that
// text is exactly what this change lets vary, so matching on it would tie
// the retry policy to git's wording.
const BOOTSTRAP_ERROR_PREFIXES = Object.freeze([
  'clone failed',
  'checkout failed',
  'warm-ready timeout',
  'warm wrapper exited before warm-ready',
]);

// Only the two failure modes with a plausible transient cause. A private
// or missing repo, and a checkout that git refused, are deterministic —
// retrying them just spends another container slot to be told the same
// thing. `warm wrapper exited before warm-ready` is deliberately NOT here
// either: the wrapper dying without emitting an error marker means it hit
// something structural, and the harvested log tail is the useful output.
const BOOTSTRAP_RETRYABLE_PREFIXES = Object.freeze([
  'clone failed',
  'warm-ready timeout',
]);

function _messageHasPrefix(err, prefixes) {
  const msg = String((err && err.message) || '');
  return prefixes.some((prefix) => msg.startsWith(prefix));
}

// True for any failure raised between `docker run` and warm-ready — i.e.
// the coding agent never started and no code was touched. Exported so the
// route layer can say that honestly instead of surfacing the raw string.
function isBootstrapError(err) {
  return err?.bootstrapFailed === true || _messageHasPrefix(err, BOOTSTRAP_ERROR_PREFIXES);
}

function isRetryableBootstrapError(err) {
  return _messageHasPrefix(err, BOOTSTRAP_RETRYABLE_PREFIXES);
}

// Attach bootstrap diagnostics to a rejection WITHOUT widening what gets
// serialized: both properties are non-enumerable, so the route layer's
// `log.error('sessions', 'Chat error', { message, stack })` and the
// `send('error', { error: err.message })` SSE frame are byte-identical to
// before. Anything that wants the detail asks for it by name.
function attachBootstrapContext(err, {
  phase = null, bootstrapLog = null, containerName = null, attempts = null,
} = {}) {
  if (!err || typeof err !== 'object') return err;
  const props = {
    bootstrapPhase: phase,
    bootstrapLog,
    bootstrapContainerName: containerName,
    bootstrapAttempts: attempts,
  };
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    try {
      Object.defineProperty(err, key, {
        value, enumerable: false, configurable: true, writable: true,
      });
    } catch { /* frozen error object — diagnostics are never worth throwing over */ }
  }
  return err;
}

// Last-resort harvest of a container that never reached warm-ready. Called
// BEFORE the container is reaped, which is the whole point: the reap used
// to happen at the start of the NEXT bootstrap attempt, so `docker logs`
// held the answer for minutes and nothing ever read it.
//
// Bounded and self-swallowing — a failure to collect diagnostics must never
// replace the real error.
async function _harvestBootstrapLog(containerName) {
  if (usesKubernetesWorkers()) return null;
  try {
    const { stdout, stderr } = await docker.execFileAsync(
      'docker', ['logs', '--tail', String(BOOTSTRAP_LOG_TAIL), containerName],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const text = `${stdout || ''}${stderr || ''}`;
    const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    if (!lines.length) return null;
    return lines.slice(-BOOTSTRAP_LOG_TAIL).join('\n').slice(-4000);
  } catch {
    return null;
  }
}

// Spawn a brand-new warm worker container. Internal to this module —
// callers should use `ensureWorker` which handles the "already warm"
// case and concurrency.
async function _bootstrapWarmContainer(sessionId, {
  repoOwner, repoName, branchName, onProgress, temporary = false,
}) {
  let containerName = workerContainerName(sessionId);

  // Public-only invariant: the worker carries no GitHub credentials in
  // its env — it relies on the unauthenticated git protocol for clones
  // and fetches. Refuse to spawn against a repo that has gone private
  // since import. Verified at import time too (verifyBotAccess), but
  // a user could flip the repo to private on GitHub after import; this
  // catches that case before we waste a container slot. Imports that
  // pre-date the public-only enforcement are caught here as well.
  const privacy = await github.checkRepoPublic(repoOwner, repoName);
  if (!privacy.ok) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: ${privacy.message}`
    );
  }
  if (privacy.private) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: repo is private. Homeroom requires public repositories. Make it public on GitHub or delete this app and re-import.`
    );
  }

  // Plain HTTPS clone URL with no embedded token. Public repos clone
  // anonymously; the credential helper in worker-run.sh is skipped when
  // PAT is unset, so the worker container ends up with no auth wired
  // into git at all.
  const cloneUrl = await github.getCloneUrl(repoOwner, repoName);

  // Commit 1 (plan 3.4): the warm container's bootstrap environment MUST
  // contain no provider keys and no worker capability tokens. The long-
  // lived container is now created with ONLY operational configuration;
  // every credential/capability is injected on the individual per-turn
  // `docker exec` instead. worker-run.sh in warm mode only clones,
  // checks out, initializes files, and sleeps.
  const ccVolume = ccVolumeName(sessionId);
  if (!usesKubernetesWorkers()) await docker.ensureVolume(ccVolume);

  const safeEnv = {
    GIT_AUTHOR_NAME: 'usernode-bot',
    GIT_AUTHOR_EMAIL: 'usernode-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'usernode-bot',
    GIT_COMMITTER_EMAIL: 'usernode-bot@users.noreply.github.com',
    BRANCH: branchName,
    // MODE=warm tells worker-run.sh to clone + checkout + sleep
    // infinity, so subsequent `docker exec` calls drive per-turn work.
    MODE: 'warm',
    // CLONE_URL has no token in it now; safe to pass inline.
    CLONE_URL: cloneUrl,
    // Used by /usr/local/bin/usernode-push to identify the calling
    // session and reach the platform's internal API.
    SESSION_ID: String(sessionId),
    PLATFORM_URL: PLATFORM_INTERNAL_URL,
  };
  if (usesKubernetesWorkers()) {
    try {
      const result = await kubernetes.ensureWorker(kubernetesWorkerConfig(), {
        sessionId, env: safeEnv, onProgress, temporary,
        reclaimVolumes: async () => {
          const pool = _getPoolSafe();
          if (!pool) return 0;
          const freed = await require('./worker-volume-reclaim').reclaimWorkerVolumes({
            pool, excludeSessionId: sessionId,
          });
          return freed.length;
        },
      });
      containerName = result.runtimeName;
      log.info('worker', 'Warm worker Pod ready', { runtimeName: containerName, pvc: result.pvcName });
      return containerName;
    } catch (err) {
      Object.defineProperty(err, 'bootstrapFailed', { value: true, configurable: true });
      log.error('worker', 'Bootstrap failed', { sessionId, containerName,
        phase: err.bootstrapPhase || null, message: log.redactString(err.message),
        logTail: err.bootstrapLog?.join('\n') || null });
      throw attachBootstrapContext(err, { containerName, attempts: 1 });
    }
  }
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const network = process.env.DOCKER_NETWORK || 'shared-web';

  // No --rm — we want the container to stick around so the host can
  // re-attach to it on restart (orphan adoption) and so eviction is
  // an explicit policy decision, not a side effect of the wrapper exiting.
  const args = [
    'run', '-d',
    '--name', containerName,
    // Clamped for HOST_NAME_MAX; see docker.containerHostname. Worker names
    // (`usernode-worker-<sessionId>`) are nowhere near the limit today — this
    // is defence in depth so the whole platform shares one hostname rule.
    '--hostname', docker.containerHostname(containerName),
    '--network', network,
    '--memory', WORKER_MEMORY,
    '--cpus', WORKER_CPUS,
    '--security-opt', 'no-new-privileges:true',
    // Warm-runtime migration marker. No secrets are injected at bootstrap,
    // and ensureWorker evicts any container whose label differs from the
    // current host/runner contract (including old images with obsolete token
    // requirements or retry behavior).
    '--label', `usernode.proxy=${WORKER_BOOTSTRAP_ENV_VERSION}`,
    '-v', `${ccVolume}:/home/node/.claude`,
    ...safeEnvArgs,
    WORKER_IMAGE,
  ];

  // Cold bootstrap is a network operation, so it gets bounded retries.
  // Everything above this line is deterministic (a private repo, a bad
  // clone URL) and is deliberately outside the loop — retrying it would
  // only re-ask GitHub the same question.
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
    // Scrub any leftover container at this name. On attempt 1 this is the
    // defensive scrub that has always been here (ensureWorker returns early
    // for `running`; anything else — exited, restarting, dead — has to go so
    // `docker run --name` can succeed). On later attempts it clears the
    // previous attempt's corpse, whose logs were already harvested below.
    await docker.stopAndRemove(containerName).catch(() => {});
    try {
      await docker.execFileAsync('docker', args, {
        timeout: 30000,
      });
      log.info('worker', 'Warm worker spawned', { containerName, ccVolume, attempt });

      // Wait for the wrapper to reach `__USERNODE_PHASE__ warm-ready`.
      // Bootstrap progress (clone/checkout) flows through onProgress so the
      // dev-chat UI sees [clone] / [checkout] phase ticks just like the
      // legacy single-shot path used to surface them.
      //
      // Attempts after the first get half the warm-ready budget, so three
      // attempts cap at 2x the old single-attempt wall clock rather than 3x.
      await _awaitWarmReady(containerName, {
        onProgress,
        timeoutMs: attempt === 1
          ? WARM_READY_TIMEOUT_MS
          : Math.round(WARM_READY_TIMEOUT_MS / 2),
      });
      return containerName;
    } catch (err) {
      // Harvest BEFORE anything reaps the container. This is the log that
      // used to sit unread in a dead container until the next attempt's
      // scrub discarded it.
      //
      // An EMPTY ring buffer is the case that most needs the harvest, not
      // the case that skips it: a container that died before printing
      // anything the tail could catch is exactly where `docker logs` holds
      // the only copy of the reason. Test on length, not presence.
      const ringTail = Array.isArray(err.bootstrapLog) && err.bootstrapLog.length
        ? err.bootstrapLog.join('\n')
        : null;
      const logTail = ringTail || await _harvestBootstrapLog(containerName);
      const retryable = isRetryableBootstrapError(err);
      const willRetry = retryable && attempt < BOOTSTRAP_MAX_ATTEMPTS;
      log.error('worker', 'Bootstrap failed', {
        sessionId,
        containerName,
        repo: `${repoOwner}/${repoName}`,
        branch: branchName,
        attempt,
        maxAttempts: BOOTSTRAP_MAX_ATTEMPTS,
        retryable,
        willRetry,
        phase: err.bootstrapPhase || null,
        message: err.message,
        logTail,
      });
      if (!willRetry) {
        throw attachBootstrapContext(err, {
          containerName,
          attempts: attempt,
          // Only when the ring buffer came up empty; otherwise this is the
          // same lines it already holds.
          bootstrapLog: ringTail || !logTail ? null : logTail.split('\n'),
        });
      }
      progress(`[retrying setup (attempt ${attempt + 1} of ${BOOTSTRAP_MAX_ATTEMPTS})]`);
      // Jittered so a platform-wide blip doesn't resynchronize every
      // session's second attempt into one burst.
      const backoffMs = BOOTSTRAP_RETRY_BASE_MS * (2 * attempt - 1);
      await new Promise((r) => setTimeout(r, backoffMs + Math.floor(Math.random() * 250)));
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new Error(`warm bootstrap exhausted ${BOOTSTRAP_MAX_ATTEMPTS} attempts for ${containerName}`);
}

// Tail `docker logs -f` until the warm-ready phase marker shows up, or
// the container dies, or we hit a timeout. SIGKILL the tail before
// returning so we don't leak children.
async function _awaitWarmReady(containerName, { onProgress, timeoutMs = WARM_READY_TIMEOUT_MS } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  return await new Promise((resolve, reject) => {
    const proc = spawn('docker', ['logs', '-f', containerName]);
    let buf = '';
    let done = false;
    // Bounded ring buffer of the last few non-marker lines, plus the last
    // phase the wrapper announced. Two of the three rejection paths below
    // (the warm-ready timeout and close-before-ready) carry no detail of
    // their own at all, so without this they say only that bootstrap did
    // not finish — never how far it got or what the container printed.
    const recent = [];
    let lastPhase = null;
    const remember = (line) => {
      recent.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
      if (recent.length > BOOTSTRAP_LOG_LINES) recent.shift();
    };
    const finish = (err) => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      clearTimeout(timer);
      if (err) {
        reject(attachBootstrapContext(err, {
          containerName,
          phase: lastPhase,
          bootstrapLog: recent.slice(),
        }));
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`warm-ready timeout for ${containerName}`)),
      timeoutMs
    );
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('__USERNODE_ERROR__')) {
          return finish(new Error(line.replace('__USERNODE_ERROR__', '').trim()));
        }
        if (line.startsWith('__USERNODE_PHASE__')) {
          const phase = line.replace('__USERNODE_PHASE__', '').trim();
          lastPhase = phase;
          progress(`[${phase}]`);
          if (phase === 'warm-ready') return finish();
          continue;
        }
        if (line.startsWith('__USERNODE_WARN__')) {
          const msg = line.replace('__USERNODE_WARN__', '').trim();
          log.warn('worker', msg, { containerName, phase: lastPhase });
          remember(`WARN ${msg}`);
          progress(`⚠ ${msg}`);
          continue;
        }
        remember(line);
        if (line.length < 500) progress(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        remember(line);
        if (line.length < 500) progress(line);
      }
    });
    proc.on('close', (code) => {
      // The warm wrapper does `exec sleep infinity`, so logs -f only
      // exits if the container died (or we SIGKILLed the tail). If we
      // hit close before warm-ready, bootstrap failed mid-flight.
      finish(new Error(`warm wrapper exited before warm-ready (code=${code})`));
    });
    proc.on('error', (err) => finish(err));
  });
}

// ──────────────────────────────────────────────────────────────────────
// Public API: ensureWorker, execInWorker, evictWorker
// ──────────────────────────────────────────────────────────────────────

// Idempotently get a warm worker container ready for `execInWorker`.
//
// Cold path: spins up the container (~5-10s docker run + clone +
// checkout + warm-ready ~5-30s). Warm path: cheap no-op once the
// container is running, even across multiple concurrent callers (the
// in-flight bootstrap promise is shared via `_warmRegistry[i].bootstrap`).
//
// Returns the container name. Throws if bootstrap fails — in which case
// the registry entry is cleared so the next caller retries from scratch.
async function ensureWorker(sessionId, {
  repoOwner, repoName, branchName,
  onProgress, temporary = false,
} = {}) {
  await accountDeletionGuard(sessionId);
  const containerName = workerRuntimeName(sessionId);

  // Coalesce concurrent ensures — if one's already racing, await it.
  const existing = _registryGet(sessionId);
  if (existing?.bootstrap) {
    await existing.bootstrap;
    await accountDeletionGuard(sessionId);
    return containerName;
  }

  // Already warm? Confirm with Docker before trusting the registry —
  // an external `docker rm` would otherwise leave stale state.
  const kubernetesWorkers = usesKubernetesWorkers();
  const workerConfig = kubernetesWorkers ? kubernetesWorkerConfig() : null;
  const status = kubernetesWorkers
    ? await kubernetes.getWorkerStatus(workerConfig, containerName)
    : await docker.getContainerStatus(containerName);
  if (status === 'running') {
    // Runtime-contract migration gate: earlier warm containers may have
    // stale bootstrap credentials, token requirements, or runner semantics
    // that the current host no longer supports. Detect them via the persisted
    // usernode.proxy label and force a re-bootstrap. Cheap — one Docker
    // inspect on the warm-path hot path.
    const runtime = kubernetesWorkers
      ? await kubernetes.getWorkerRuntimeMetadata(workerConfig, containerName)
      : null;
    const labels = kubernetesWorkers
      ? { 'usernode.proxy': runtime.contractVersion }
      : await docker.getContainerLabels(containerName);
    const staleReason = labels['usernode.proxy'] !== WORKER_BOOTSTRAP_ENV_VERSION
      ? 'runtime-contract'
      : (kubernetesWorkers && runtime.imageRef !== workerConfig.kubernetes.workerImage
        ? 'worker-image'
        : (kubernetesWorkers && runtime.storageMode !== (temporary ? 'temporary' : 'persistent')
          ? 'storage-mode' : null));
    if (staleReason) {
      // A recovered/in-flight turn owns this worker until it settles. Normal
      // dispatch serialization means this is defensive, but keep the image
      // rollout from ever becoming a reason to interrupt paid work.
      if (existing?.inFlight) {
        if (staleReason === 'storage-mode') {
          throw new Error('Cannot change worker storage while a turn is running');
        }
        log.info('worker', 'Deferring stale warm worker replacement until turn completion', {
          containerName, staleReason,
        });
        return containerName;
      }
      log.info('worker', kubernetesWorkers
        ? 'Reconciling stale warm worker'
        : 'Evicting stale warm worker', {
        containerName,
        staleReason,
        currentImage: runtime?.imageRef || null,
        expectedImage: workerConfig?.kubernetes.workerImage || null,
      });
      if (!kubernetesWorkers) {
        await evictWorker(sessionId).catch((err) => {
          log.warn('worker', 'Eviction failed; falling through to bootstrap', {
            containerName, err: err.message,
          });
        });
      }
      // Kubernetes falls through without deleting the Deployment. Its
      // Recreate strategy updates the immutable image and stops the old Pod
      // before starting the replacement, while the retained PVC stays put.
      // fall through to the bootstrap branch below
    } else {
      if (!existing) {
        _registryUpsert(sessionId, { containerName, lastUsedMs: Date.now(), inFlight: false });
      }
      return containerName;
    }
  }

  // Anything else (exited, dead, restarting, or not_found): re-bootstrap.
  // _bootstrapWarmContainer reaps any stale container before docker run.
  const bootstrap = (async () => {
    try {
      const runtimeName = await _bootstrapWarmContainer(sessionId, {
        repoOwner, repoName, branchName, onProgress, temporary,
      });
      await accountDeletionGuard(sessionId);
      _registryUpsert(sessionId, {
        containerName: runtimeName,
        bootstrap: null,
        lastUsedMs: Date.now(),
        inFlight: false,
        adopted: false,
      });
    } catch (err) {
      _warmRegistry.delete(sessionId);
      throw err;
    }
  })();
  _registryUpsert(sessionId, { bootstrap });
  await bootstrap;
  return containerName;
}

// Run one CC turn inside an already-warm container, detached: the exec
// is dispatched with `docker exec -d`, its output lands in a journal
// file in the CC volume, and we follow the journal through the shared
// `parseLine` state machine. The dev-chat UI sees identical progress
// markers to the old attached transport — but the turn itself survives
// a platform restart (boot adoption resumes it via the
// chat_sessions.active_turn record + resumeTurnFromJournal).
//
// Returns the same shape watchWorker produces, so route callers can swap
// `spawnWorker + watchWorker` for `ensureWorker + execInWorker` without
// touching the post-processing logic (PR creation, staging build, etc.).
async function execInWorker(sessionId, {
  mode = 'build',
  // #2737: called with { inputTokens, cachedInputTokens, outputTokens }
  // each time the provider reports usage, so a caller can end a turn on its
  // token spend rather than only on the clock. Optional; see the call in
  // applyClaudeResultUsage for the best-effort contract.
  onUsage = null,
  prompt,
  // Complete task prompt for the one fresh retry run-cc.sh performs when a
  // hosted Claude --resume id is stale. Null for ordinary builds and every
  // non-Claude backend. This remains user-level input; it is never promoted
  // into the authoritative system-context transport below.
  resumeFallbackPrompt = null,
  // Hosted Claude system context. Materialized separately so it is a stable
  // instruction layer, not another conversation message.
  systemPrompt = null,
  // Restart recovery can reuse the prompt file deliberately retained by a
  // runner that emitted agent_retry_fresh=1. Live calls keep writing the
  // supplied prompt exactly as before.
  reusePromptFile = false,
  model,
  commitMsg,
  resumeSessionId,
  branchName,
  anthropicApiKey,
  // Backend selection (plan.md): when 'codex_openrouter', the turn is
  // dispatched to the Codex runner with the user's per-exec OpenRouter key
  // (direct transport) instead of the Claude runner + Anthropic proxy.
  // Defaults to claude_code (unchanged behavior).
  agentBackend = 'claude_code',
  // #3296: which CLI runs an OpenRouter turn — 'codex' (the default, and the
  // only runner before harnesses existed) or 'claude'. Ignored for
  // claude_code, which is always Claude Code on Anthropic.
  agentHarness = null,
  // Codex/OpenRouter-specific turn context (direct transport, review P0):
  // the user's OpenRouter key is passed in ONLY for this specific docker
  // exec (injected as OPENROUTER_API_KEY into the per-turn environment),
  // plus the session-pinned model and reasoning effort.
  agentModel = null,
  agentReasoningEffort = null,
  agentModelMetadata = null,
  openrouterApiKey = null,
  openrouterApiBase = null,
  shotsRunId = null,
  shotsOrigins = null,
  shotsAuthTokens = null,
  shotsNavigationHints = null,
  // Record browser video for this turn: only when a declared change is
  // motion a still cannot show.
  shotsRecordClips = false,
  // The size clips are recorded at, WIDTHxHEIGHT: the motion screens' own,
  // so a phone clip is not a phone in the corner of a desktop-sized frame.
  shotsClipSize = null,
  // The app under test is a child app: the shots proxy serves its
  // /usernode-bridge|native|tailwind/ requests from the platform, as the
  // production edge does. The platform's own pairs serve their own.
  shotsPlatformAssets = false,
  turnUuid = null,
  logicalTurnId = null,
  attemptNumber = null,
  // Content-free component attribution for #717. Persisted in active_turn
  // so restart recovery records the same physical invocation exactly once.
  telemetryComponent = null,
  telemetryCorrelationId = null,
  telemetryAttemptNumber = null,
  // Optional preselected journal path. Codex attempt registration can supply
  // a deterministic path once attempt creation moves into the same DB
  // transaction; ordinary callers leave it null.
  journalPath = null,
  onProgress,
  // Content-free lifecycle events for the owner-only shots trace.
  // Never pass journal text, tool arguments/results, URLs or model output.
  onShotsDiagnostic = null,
  // #616: when true (admin-owned session on the self-edit app — the
  // caller checks via debug-access.isEligible), the turn env gains
  // PROD_DEBUG_JWT so the usernode-debug CLI can call the platform's
  // read-only prod-debug internal API. Build/scout only, never sync.
  prodDebug = false,
  // When true the caller owns a post-agent TAIL (PR → staging → cards →
  // wrap-up) and takes over the turn record's lifetime: this function
  // stamps `phase: 'tail_pending'` instead of clearing it, and leaves the journal
  // on disk so a restart mid-tail can replay the turn. The caller MUST
  // call finishTurn(sessionId, { turnId }) at its explicit completion
  // boundary. Interactive callers may defer that boundary through the Mayor
  // wrap-up; headless callers finish in their own tool-side finally. See the
  // "Post-agent TAIL" note above. Default false — the sync path and any
  // future tail-less caller keep the original clear-on-exit behaviour.
  holdTurnRecord = false,
  // Kept as a compatibility option for older call sites. Persistence is now
  // required for every dispatch, not only recovered retries.
  requireActiveTurnPersistence = false,
  // Legacy callback: the attached transport used to hand the host-side
  // `docker exec` child to the route handler for SIGTERM-based stops.
  // The detached transport has no such child — stops go through
  // stopTurn() — so this is invoked with null purely for back-compat.
  onChild,
} = {}) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`execInWorker: no warm worker registered for session ${sessionId}`);
  }
  if (meta.inFlight) {
    // Coded so a caller can tell "wait for the running turn" from a real
    // dispatch failure without matching on the message — the merge queue
    // treats this one as in-progress rather than as a sync that failed.
    throw Object.assign(
      new Error(`execInWorker: a turn is already in flight for session ${sessionId}`),
      { code: 'TURN_IN_FLIGHT' }
    );
  }
  if (!prompt && !reusePromptFile) {
    throw new Error('execInWorker: prompt required');
  }
  if (systemPrompt != null && (typeof systemPrompt !== 'string' || !systemPrompt.trim())) {
    throw new Error('execInWorker: systemPrompt must be a non-empty string');
  }
  if (resumeFallbackPrompt != null
      && (typeof resumeFallbackPrompt !== 'string' || !resumeFallbackPrompt.trim())) {
    throw new Error('execInWorker: resumeFallbackPrompt must be a non-empty string');
  }
  const containerName = meta.containerName;
  const durableTurnId = logicalTurnId || turnUuid || turnLifecycle.newTurnId();
  const dispatchSetupStartedMs = Date.now();
  // Only caller-supplied identities can already own a durable row at this
  // point. A legacy Claude dispatch gets its active_turn below, after the
  // stop gate, so its freshly generated fallback id must not be returned as
  // though it had been registered when the gate prevents that write.
  const preRegisteredTurnId = logicalTurnId || turnUuid || null;

  // #937: honour a stop that was requested while this turn was still
  // spinning up. Historically the dispatch upsert below cleared
  // `stopRequestedAt` — it could not tell a previous turn's leftover from
  // a stop aimed at THIS turn seconds ago — so a stop clicked during
  // ensureWorker/syncUserAgentFiles was erased by the very dispatch it was
  // meant to prevent, and the agent ran to completion (production session
  // 2974: 17m51s of agent time after the click). The flag is now cleared
  // only at a real new-turn boundary via clearPendingStop(), so reading it
  // here is authoritative.
  //
  // Checked FIRST, ahead of the JWT mint and the prompt-file write, so a
  // stop that has already landed costs nothing at all — and returns the
  // shape a genuinely killed turn produces, so every downstream consumer
  // (the caller's stopped branch, the tail, the watchdog) behaves exactly
  // as it does for a real in-flight kill.
  if (getPendingStop(sessionId)) {
    log.info('worker', 'Dispatch skipped — stop requested during spin-up', {
      sessionId, containerName, mode,
    });
    const stopped = newWatchState();
    // Codex registers its ledger row + durable active_turn atomically before
    // entering this function. Preserve that already-owned logical identity
    // even though no paid dispatch occurred, so the caller can terminalize
    // the attempt and release the dispatch_pending record immediately.
    stopped.turnId = preRegisteredTurnId;
    stopped.agentBackend = agentBackend;
    stopped.agentHarness = resolveTurnBackend(agentBackend, agentHarness).harness;
    stopped.execExitSeen = true;
    stopped.exitCode = 143;
    return stopped;
  }

  // Re-mint the JWT on every turn so the worker's auth always has at
  // least WORKER_JWT_TTL left, regardless of how long the warm
  // container has been alive. This avoids edge cases where a session
  // outlives its bootstrap-time token (24h is the cap today; could be
  // shorter later) and the next push fails with 401 from the proxy.
  // One backend decision for this whole dispatch (review Commit 1 /
  // plan 3.1): all runner/token/env/active-turn choices derive from it.
  const {
    backend: resolvedBackend, harness: resolvedHarness, isCodex, isClaude,
    isClaudeOpenRouter, isOpenRouter, runsClaude,
  } = resolveTurnBackend(agentBackend, agentHarness);
  // Every shots turn runs on Claude Code (shots-agent
  // dispatches only claude_code); neither OpenRouter harness has a shots
  // mode, so refuse before anything is minted or written.
  if (mode === 'shots' && !isClaude) {
    throw new Error('execInWorker: shots turns run on Claude Code');
  }
  if (isClaudeOpenRouter && !['scout', 'build'].includes(mode)) {
    throw new Error(`execInWorker: Claude over OpenRouter supports scout and build turns, not ${mode}`);
  }
  if (systemPrompt && !runsClaude) {
    throw new Error('execInWorker: systemPrompt is only supported for Claude turns');
  }
  if (resumeFallbackPrompt && !isClaude) {
    throw new Error('execInWorker: resumeFallbackPrompt is only supported for Claude turns');
  }
  if (resumeFallbackPrompt && mode !== 'build') {
    throw new Error('execInWorker: resumeFallbackPrompt is only supported for build turns');
  }
  if (resumeFallbackPrompt && !resumeSessionId) {
    throw new Error('execInWorker: resumeFallbackPrompt requires resumeSessionId');
  }
  if (isClaude && ['build', 'shots'].includes(mode) && !systemPrompt) {
    throw new Error(`execInWorker: hosted Claude ${mode} requires systemPrompt`);
  }
  if (mode === 'shots') {
    if (!/^[0-9a-f]{32}$/.test(String(shotsRunId || ''))
        || !shotsOrigins || !shotsAuthTokens) {
      throw new Error('execInWorker: shots mode requires a run id, paired origins, and auth tokens');
    }
    for (const side of ['base', 'head']) {
      let parsed;
      try { parsed = new URL(shotsOrigins[side]); } catch {}
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/') {
        throw new Error(`execInWorker: invalid ${side} shots origin`);
      }
    }
    if (typeof shotsRecordClips !== 'boolean') {
      throw new Error('execInWorker: shots clip recording must be boolean');
    }
    if (shotsClipSize != null && !/^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(String(shotsClipSize))) {
      throw new Error('execInWorker: shots clip size must be WIDTHxHEIGHT');
    }
    if (typeof shotsPlatformAssets !== 'boolean') {
      throw new Error('execInWorker: shots platform assets must be boolean');
    }
  }
  const useAnthropicProxy = isClaude && !anthropicApiKey;
  const measuredTelemetryComponent = llmTelemetry.collectionComponent(telemetryComponent);
  const measuredTelemetryCorrelationId = isClaude && measuredTelemetryComponent
    ? (telemetryCorrelationId || durableTurnId)
    : null;
  const measuredTelemetryAttemptNumber = isClaude && measuredTelemetryComponent
    ? (Number(telemetryAttemptNumber) || Number(attemptNumber) || 1)
    : null;

  // Backend-specific capability minting (plan 3.2). Crucially,
  // mintWorkerJwt() (general worker:session) NEVER runs for a Codex turn —
  // the property is structural, not "hide the already-minted token".
  let workerSessionJwt = null;
  let workerPushJwt = null;
  let issuesReadJwt = null;
  let anthropicProxyJwt = null;
  let prodDebugJwt = null;
  let shotsJwt = null;
  if (mode !== 'shots') issuesReadJwt = mintIssuesReadJwt(sessionId);
  else shotsJwt = mintShotsJwt(sessionId, shotsRunId);
  if (isOpenRouter) {
    if (mode === 'build') {
      workerPushJwt = mintWorkerPushJwt(sessionId);
    }
  } else {
    // A scout must never mint a general token at all. Hiding WORKER_JWT while
    // placing the same capability in ISSUES_JWT/ANTHROPIC_API_KEY is not an
    // isolation boundary when the agent has Bash.
    if (mode !== 'scout' && mode !== 'shots') workerSessionJwt = mintWorkerJwt(sessionId);
    if (useAnthropicProxy) anthropicProxyJwt = mintAnthropicProxyJwt(sessionId);
    if (prodDebug && mode !== 'sync' && mode !== 'shots') {
      prodDebugJwt = mintProdDebugJwt(sessionId);
    }
  }

  const claudeModel = claudeTurnModel(mode, model);
  const persistedModel = isOpenRouter ? (agentModel || '') : claudeModel;

  // The prompt travels as a file, never as exec argv/env — a single
  // argv/env string is capped at 128 KiB on Linux, and build prompts
  // (conventions block + spec doc) legitimately exceed it. See
  // TURN_PROMPT_PATH. Written before active_turn is persisted so a
  // failure here surfaces as a plain turn error with nothing to reap.
  if (!reusePromptFile) {
    await writeTurnPrompt(sessionId, prompt);
  }
  if (resumeFallbackPrompt) {
    await writeTurnResumeFallbackPrompt(sessionId, resumeFallbackPrompt);
  }
  // A reused task prompt is a Codex recovery concern today, but keep this
  // write independent so any future Claude recovery cannot point the runner
  // at an absent or stale system-context file.
  if (systemPrompt) await writeTurnSystemPrompt(sessionId, systemPrompt);

  // Anthropic-proxy: when the caller provides a BYOK key (anthropicApiKey
  // truthy), the worker hits api.anthropic.com directly with that key
  // — same flow as before. When no BYOK key is provided we route the
  // SDK's traffic through the platform's in-process proxy at
  // /api/internal/anthropic. The `claude` CLI honors ANTHROPIC_BASE_URL
  // for endpoint retargeting and ANTHROPIC_API_KEY as the x-api-key
  // header, so we put a purpose-bound worker:anthropic-proxy token in
  // ANTHROPIC_API_KEY: the proxy verifies it, swaps in the real
  // platform key, and forwards. The real key never enters the worker
  // container, so a malicious prompt like "echo $ANTHROPIC_API_KEY"
  // exfiltrates only a short-lived JWT that's useless against
  // api.anthropic.com directly.
  // #2779: minted after the prompt files are written (a failure there has
  // nothing to revoke), and revoked on every exit from here on.
  const homeroomGrant = await mintHomeroomReadGrant(sessionId, mode);
  let secretEnv;
  try {
    secretEnv = buildTurnSecretEnv({
      mode,
      agentBackend: resolvedBackend,
      agentHarness: resolvedHarness,
      workerSessionJwt,
      workerPushJwt,
      issuesReadJwt,
      anthropicProxyJwt,
      anthropicApiKey,
      prodDebugJwt,
      openrouterApiKey,
      shotsJwt,
      shotsMemberToken: shotsAuthTokens?.member,
      shotsAdminToken: shotsAuthTokens?.read_only_admin,
      shotsFullAdminToken: shotsAuthTokens?.full_admin,
      homeroomMcpToken: homeroomGrant ? homeroomGrant.token : null,
    });
  } catch (err) {
    await revokeHomeroomReadGrant(sessionId, homeroomGrant);
    throw err;
  }
  const safeEnv = {
    PROMPT_FILE: TURN_PROMPT_PATH,
    SYSTEM_PROMPT_FILE: systemPrompt ? TURN_SYSTEM_PROMPT_PATH : '',
    MODE: mode,
    BRANCH: branchName || '',
    COMMIT_MSG: commitMsg || 'Changes via Homeroom',
    SESSION_ID: String(sessionId),
    PLATFORM_URL: mode === 'shots' ? shotsControlUrl() : PLATFORM_INTERNAL_URL,
    ...(mode === 'shots' ? {
      SHOTS_RUN_ID: shotsRunId,
      SHOTS_BASE_ORIGIN: new URL(shotsOrigins.base).origin,
      SHOTS_HEAD_ORIGIN: new URL(shotsOrigins.head).origin,
      SHOTS_NAVIGATION_HINTS: JSON.stringify(shotsNavigationHints || {}),
      SHOTS_RECORD_CLIPS: shotsRecordClips ? '1' : '0',
      ...(shotsRecordClips && shotsClipSize ? { SHOTS_CLIP_SIZE: String(shotsClipSize) } : {}),
      SHOTS_PLATFORM_ASSETS: shotsPlatformAssets ? '1' : '0',
    } : {}),
    ...(isClaude ? {
      MODEL: claudeModel,
      CLAUDE_RESUME_SESSION_ID: resumeSessionId || '',
      RESUME_FALLBACK_PROMPT_FILE: resumeFallbackPrompt
        ? TURN_RESUME_FALLBACK_PROMPT_PATH
        : '',
      // Retarget the Anthropic SDK through the proxy only for Claude when
      // not BYOK. Never set for Codex.
      ...(useAnthropicProxy
        ? { ANTHROPIC_BASE_URL: `${PLATFORM_INTERNAL_URL}/api/internal/anthropic` }
        : {}),
    } : {}),
    // Optional in-loop browser: build-only INLOOP_* env (port,
    // USERNODE_ENV=staging, throwaway DB pointer) the agent uses to boot
    // the edited app locally for a headless visual check. Empty for
    // scout/sync.
   ...inLoopBrowser.browserEnvForMode(mode),
 };
  if (isClaudeOpenRouter) {
    // #3296: run-cc.sh drives Claude Code through the worker-local Messages
    // adapter (worker/claude-openrouter-request.js) instead of Anthropic. The
    // model is the session-pinned OpenRouter slug; the adapter pins every
    // request to it, caps the reply at the catalog's output limit and sets
    // the reasoning effort. The resume id is the Claude session this
    // OpenRouter thread recorded.
    safeEnv.AGENT_PROVIDER = 'openrouter';
    safeEnv.MODEL = agentModel || '';
    safeEnv.AGENT_MODEL = agentModel || '';
    safeEnv.AGENT_MODEL_MAX_OUTPUT_TOKENS = agentModelMetadata?.maxOutputTokens != null
      ? String(agentModelMetadata.maxOutputTokens)
      : '';
    // The thinking level, which the adapter sends as output_config.effort.
    safeEnv.AGENT_REASONING_EFFORT = agentReasoningEffort || '';
    safeEnv.CLAUDE_RESUME_SESSION_ID = resumeSessionId || '';
    safeEnv.RESUME_FALLBACK_PROMPT_FILE = '';
    safeEnv.TURN_UUID = turnUuid || '';
    safeEnv.OPENROUTER_API_BASE = openrouterApiBase || '';
  }
  if (isCodex) {
    safeEnv.AGENT_BACKEND = 'codex_openrouter';
    safeEnv.AGENT_MODEL = agentModel || '';
    safeEnv.AGENT_REASONING_EFFORT = agentReasoningEffort || '';
    safeEnv.AGENT_MODEL_NAME = agentModelMetadata?.name || agentModel || '';
    safeEnv.AGENT_MODEL_CONTEXT_WINDOW = agentModelMetadata?.contextWindow != null
      ? String(agentModelMetadata.contextWindow)
      : '';
    safeEnv.AGENT_MODEL_MAX_OUTPUT_TOKENS = agentModelMetadata?.maxOutputTokens != null
      ? String(agentModelMetadata.maxOutputTokens)
      : '';
    safeEnv.AGENT_MODEL_SUPPORTS_REASONING = agentModelMetadata?.supportsReasoning == null
      ? ''
      : (agentModelMetadata.supportsReasoning ? '1' : '0');
    safeEnv.AGENT_MODEL_REASONING_EFFORTS = Array.isArray(agentModelMetadata?.reasoningEfforts)
      ? agentModelMetadata.reasoningEfforts.join(',')
      : '';
    safeEnv.AGENT_MODEL_SUPPORTS_TOOLS = agentModelMetadata?.supportsTools == null
      ? ''
      : (agentModelMetadata.supportsTools ? '1' : '0');
    safeEnv.AGENT_THREAD_ID = resumeSessionId || '';
    safeEnv.TURN_UUID = turnUuid || '';
    // The operator-configured OpenRouter endpoint (plan 4): always forward
    // the (already-validated) base so generation and catalog agree.
    safeEnv.OPENROUTER_API_BASE = openrouterApiBase || '';
  }
  const runner = registry.runnerFor(resolvedBackend, resolvedHarness);
 // Journal transport: the turn runs DETACHED from this process. The
  // wrapper below redirects run-cc.sh's combined output to a journal
  // file in the CC volume and appends __USERNODE_EXIT__ <code> when it
  // finishes. We then tail the journal from line 0. If the platform
  // restarts mid-turn, the exec keeps running, the journal keeps
  // filling, and the boot adoption path resumes via the same consumer
  // (resumeTurnFromJournal) using the chat_sessions.active_turn record.
  const journal = journalPath || turnJournalPath(durableTurnId);
  safeEnv.TURN_JOURNAL = journal;

  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'exec', '-d',
    ...secretEnvArgs,
    ...safeEnvArgs,
    containerName,
    'sh', '-c',
    // rm stale journals first so the tailer's existence-wait can't latch
    // onto a leftover file from a previous turn. After the run, decide
    // whether attempt two needs the prompt BEFORE publishing the exit marker:
    // the marker releases the host to start attempt two, so no shared prompt
    // mutation may happen after it becomes observable.
    'rm -f /home/node/.claude/turn-*.log 2>/dev/null; '
      + runner + ' > "$TURN_JOURNAL" 2>&1; '
      + 'TURN_EXIT=$?; '
      // A missing-thread result is a durable hand-off to attempt two. Keep
      // the prompt in the private worker volume until the host (or restart
      // recovery) has launched that attempt. Every other terminal path
      // removes it immediately as before.
      + 'if ! grep -qE "^__USERNODE_RESULT__ .*agent_retry_fresh=1([[:space:]]|$)" "$TURN_JOURNAL"; then '
      + 'rm -f "$PROMPT_FILE" 2>/dev/null; fi; '
      + 'if [ -n "$RESUME_FALLBACK_PROMPT_FILE" ]; then '
      + 'rm -f "$RESUME_FALLBACK_PROMPT_FILE" 2>/dev/null; fi; '
      + 'if [ -n "$SYSTEM_PROMPT_FILE" ]; then rm -f "$SYSTEM_PROMPT_FILE" 2>/dev/null; fi; '
      + 'echo "__USERNODE_EXIT__ $TURN_EXIT" >> "$TURN_JOURNAL"; exit "$TURN_EXIT"',
  ];

  // #361: record the in-flight turn's mode in the warm registry so the
  // Anthropic proxy can synchronously tell a sync turn from a build turn
  // and gate it against the system-token budget instead of the owner's.
  // #664: fresh per-turn BYOK spillover counters — see noteTurnByokSpend.
  // `journal` is recorded so stopTurn() can append the exit marker to the
  // turn's own journal (#889) instead of leaving the consumer to discover
  // the kill via its 10s liveness watchdog.
  _registryUpsert(sessionId, {
    inFlight: true, activeTurnMode: mode, journal, activeTurnId: durableTurnId,
    turnByokCents: 0, turnByokSwitched: false,
  });
  const activeTurnPersisted = await _persistActiveTurn(sessionId, {
    turnId: durableTurnId,
    phase: turnLifecycle.PHASE_DISPATCH_PENDING,
    mode,
    journal,
    backend: resolvedBackend,
    // Restart recovery replays the journal with this harness's parser.
    harness: resolvedHarness || undefined,
    turnUuid: turnUuid || undefined,
    // plan 7.4: persist the attempt identity so interactive/headless
    // recovery can terminalize the correct agent_turns row idempotently.
    logicalTurnId: logicalTurnId || undefined,
    attemptNumber: attemptNumber || undefined,
    telemetryComponent: measuredTelemetryComponent || undefined,
    telemetryCorrelationId: measuredTelemetryCorrelationId || undefined,
    telemetryAttemptNumber: measuredTelemetryAttemptNumber || undefined,
    telemetryRequestMode: resumeSessionId ? 'agent_resume' : 'agent_new',
    telemetryRequestTextCharacters: typeof prompt === 'string' ? prompt.length : undefined,
    telemetryRequestSystemCharacters: typeof systemPrompt === 'string'
      ? systemPrompt.length
      : undefined,
    telemetryRequestPayloadCharacters: typeof prompt === 'string'
      ? prompt.length + (typeof systemPrompt === 'string' ? systemPrompt.length : 0)
      : undefined,
    telemetryModelContextWindowTokens: agentModelMetadata?.contextWindow ?? undefined,
    telemetryModelMaxOutputTokens: agentModelMetadata?.maxOutputTokens ?? undefined,
    model: persistedModel,
    startedAt: new Date().toISOString(),
    // #174: billing context for restart-resume — the resume paths debit
    // the recovered costUsd into the bucket the turn actually billed,
    // even if the user adds/removes their key while the turn is detached.
    byok: !!anthropicApiKey,
  });
  if (!activeTurnPersisted) {
    _registryUpsert(sessionId, {
      inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null,
      journal: null, activeTurnId: null,
    });
    await revokeHomeroomReadGrant(sessionId, homeroomGrant);
    const err = new Error('execInWorker: durable active turn could not be persisted');
    err.code = requireActiveTurnPersistence
      ? 'durable_retry_persist_failed'
      : 'durable_turn_persist_failed';
    throw err;
  }

  // Visible to the `finally` below, which stamps the tail's seed
  // milestones (sha / pushOk) from whatever the exec established.
  let execState = null;
  let providerStartedAt = null;
  let providerStartedMs = null;
  let providerDispatched = false;
  let providerTerminalObserved = false;
  try {
    // Dispatch. `docker exec -d` returns as soon as the exec is created;
    // secrets travel via the docker CLI's env (bare `-e KEY`), same as
    // the attached transport did.
    providerStartedAt = new Date();
    providerStartedMs = Date.now();
    if (usesKubernetesWorkers()) {
      const exports = Object.entries({ ...secretEnv, ...safeEnv })
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join('\n');
      const detached = `${exports}\nnohup sh -c ${shellQuote(args[args.length - 1])} >/dev/null 2>&1 &\n`;
      await execWorkerCommand(containerName, ['sh', '-s'], detached, { timeoutMs: 30000 });
    } else {
      await docker.execFileAsync('docker', args, {
        timeout: 30000,
        env: { ...process.env, ...secretEnv },
      });
    }
    providerDispatched = true;
    // The durable dispatch record was committed before docker exec. Advancing
    // the phase is required for normal operation, but after the process has
    // started a transient DB error cannot safely be turned into a second
    // dispatch. Leave dispatch_pending in place; boot recovery treats both
    // dispatch_pending and executing as journal-resumable and never blindly
    // reissues the provider request.
    await turnLifecycle.markExecuting(_getPoolSafe(), {
      sessionId, turnId: durableTurnId,
    }).catch((err) => log.warn('worker', 'Failed to mark turn executing; durable dispatch remains recoverable', {
      sessionId, turnId: durableTurnId, err: err.message,
    }));
    // onChild is legacy: there is no host-side child that owns the turn
    // anymore. Stop semantics live in stopTurn() (in-container pkill).
    if (typeof onChild === 'function') {
      try { onChild(null); } catch {}
    }

    // #937: belt-and-braces re-arm. The pre-dispatch gate above closes the
    // spin-up window, but a stop can still land in the milliseconds while
    // `docker exec -d` is in flight — and that kill would have found no
    // turn process to match. Now that the registry knows THIS turn's
    // journal path, re-issuing the kill lands the TERM/KILL plus the
    // `__USERNODE_EXIT__ 143` marker, so the consumer below resolves on
    // its next journal read (~1s) instead of on the 10s watchdog.
    if (getPendingStop(sessionId)) {
      log.info('worker', 'Stop landed during dispatch — re-issuing kill', {
        sessionId, containerName, journal,
      });
      await stopTurn(sessionId).catch(() => {});
    }

    const state = newWatchState();
    state.turnId = durableTurnId;
    // #2737: forwarded to applyClaudeResultUsage, which calls it on every
    // usage event the provider reports. Undefined for every caller but the
    // Homeroom bot's budget guard.
    state.onUsage = typeof onUsage === 'function' ? onUsage : null;
    state.liveSpendEnabled = isClaude && mode !== 'sync';
    workerProgress.setSpend(sessionId, null);
    state.hostSessionId = sessionId;
    state.hostContainerName = containerName;
    state.providerDispatched = true;
    // Seed the backend BEFORE consuming the journal (review P4): parseLine
    // routes JSON events to the Codex adapter only when
    // state.agentBackend === 'codex_openrouter'. The runner emits
    // agent_backend in __USERNODE_RESULT__ (too late for the events), so
    // we seed it from the dispatch param up front.
    state.agentBackend = agentBackend;
    // #3296: and the harness, which decides that parser for OpenRouter.
    state.agentHarness = resolvedHarness;
    if (mode === 'shots') {
      state.shotsOrigins = shotsOrigins;
      state.shotsNavigationHints = shotsNavigationHints;
    }
    if (mode === 'shots' && typeof onShotsDiagnostic === 'function') {
      state.shotsDiagnosticObserver = onShotsDiagnostic;
      emitShotsDiagnostic(state, {
        kind: 'provider_dispatched',
        backend: 'claude_code',
        requestMode: resumeSessionId ? 'agent_resume' : 'agent_new',
      });
    }
    state.telemetryDiagnosticsEnabled = !!measuredTelemetryComponent;
    if (runsClaude) {
      state.providerRateLimitEventCount = 0;
      state.contextCompactionCount = 0;
    }
    if (isOpenRouter) state.providerRetryCount = 0;
    state.providerStartedMs = providerStartedMs;
    state.dispatchSetupDurationMs = providerStartedMs == null
      ? null
      : Math.max(0, providerStartedMs - dispatchSetupStartedMs);
    state.requestMode = resumeSessionId ? 'agent_resume' : 'agent_new';
    state.requestMessageCount = typeof prompt === 'string' ? 1 : null;
    state.requestUserMessageCount = typeof prompt === 'string' ? 1 : null;
    state.requestContentBlockCount = typeof prompt === 'string' ? 1 : null;
    state.requestTextCharacters = typeof prompt === 'string' ? prompt.length : null;
    state.requestUserTextCharacters = typeof prompt === 'string' ? prompt.length : null;
    state.requestSystemCharacters = typeof systemPrompt === 'string' ? systemPrompt.length : null;
    state.requestPayloadCharacters = typeof prompt === 'string'
      ? prompt.length + (state.requestSystemCharacters || 0)
      : null;
    if (persistedModel) state.providerModelCount = 1;
    state.modelContextWindowTokens = agentModelMetadata?.contextWindow ?? null;
    state.modelMaxOutputTokens = agentModelMetadata?.maxOutputTokens ?? null;
    execState = state;
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId, startedAt: providerStartedAt });
    providerTerminalObserved = true;

    // Successful, complete turns don't need their journal anymore; failed
    // or markerless ones keep it on disk for debugging (the next turn's
    // wrapper rm's it).
    //
    // A tail-holding caller keeps it either way until finishTurn: it is
    // the only copy of what the turn did, and the boot-adoption resume
    // replays it to rebuild `result` before running the tail.
    if (!holdTurnRecord && state.execExitSeen && !state.fatalError) {
      execWorkerCommand(containerName, ['rm', '-f', journal]).catch(() => {});
    }
    return finalizeHarnessResult(state);
  } finally {
    // The agent process is done with the platform once its journal has
    // ended: the tail (PR, staging, the wrap-up) never uses this token.
    await revokeHomeroomReadGrant(sessionId, homeroomGrant);
    if (providerDispatched && providerTerminalObserved && isClaude && measuredTelemetryComponent) {
      recordClaudeCodingRun({
        sessionId,
        turnId: durableTurnId,
        result: execState,
        requestedModel: persistedModel,
        component: measuredTelemetryComponent,
        startedAt: providerStartedAt,
        durationMs: providerStartedMs == null ? null : Date.now() - providerStartedMs,
        directByok: !!anthropicApiKey,
        byokCents: getTurnByokCents(sessionId),
        attemptNumber: measuredTelemetryAttemptNumber,
        correlationId: measuredTelemetryCorrelationId,
      });
    }
    // #937: `stopRequestedAt` deliberately survives this teardown. The
    // turn's own tail (post-run stopped-check, force-stop bookkeeping)
    // still needs to know a stop was requested; clearPendingStop() at the
    // next turn's boundary is what resets it.
    _registryUpsert(sessionId, {
      inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null,
      journal: null, activeTurnId: null,
      // Remembered for finishTurn so the caller's `finally` doesn't have
      // to thread the journal path back through its own scope.
      ...(holdTurnRecord ? { finishedJournal: journal, finishedTurnId: durableTurnId } : {}),
    });
    if (holdTurnRecord) {
      // Hand the record to the tail rather than dropping it. Seed the
      // milestone map with what the exec itself established, so a resume
      // knows whether the commit is already on GitHub without having to
      // re-derive it from a dead worker.
      await markTurnTail(sessionId, execState
        ? { sha: execState.sha || null, pushOk: execState.pushOk === true }
        : {}, { turnId: durableTurnId, journal });
    } else {
      await finishTurn(sessionId, { turnId: durableTurnId, journal });
    }
  }
}

// #361: synchronous read of the mode of the turn currently in flight for
// a session ('build' | 'sync' | 'scout' | …), or null when idle. Used by
// the Anthropic proxy to route sync turns onto the system-token cap.
function getActiveTurnMode(sessionId) {
  const meta = _warmRegistry.get(Number(sessionId));
  return (meta && meta.inFlight) ? (meta.activeTurnMode || null) : null;
}

// ──────────────────────────────────────────────────────────────────────
// #664: per-turn BYOK spillover accounting
// ──────────────────────────────────────────────────────────────────────
//
// The worker Anthropic proxy can switch a platform-dispatched turn onto
// the owner's own key per-call once the daily allowance runs out. The
// switched calls' observed costs accumulate here (registry, for the live
// turn-end settlement) AND in chat_sessions.active_turn.byokCents (for
// restart-resume — the SQL accumulate never clobbers pre-restart spend).
// execInWorker resets both fields at dispatch; resumeTurnFromJournal
// seeds them from the persisted record.

// Record `cents` of BYOK-billed spend against the session's in-flight
// turn. Fire-and-forget on the durable mirror: billing bookkeeping must
// never fail the API call that incurred it.
function noteTurnByokSpend(sessionId, cents) {
  const sid = Number(sessionId);
  if (!(cents > 0)) return;
  const meta = _warmRegistry.get(sid);
  _registryUpsert(sid, { turnByokCents: ((meta && meta.turnByokCents) || 0) + cents });
  const pool = _getPoolSafe();
  const activeTurnId = meta?.activeTurnId || null;
  if (pool && activeTurnId) {
    turnLifecycle.incrementByokCents(pool, {
      sessionId: sid,
      turnId: activeTurnId,
      cents,
    }).catch((err) => {
      log.warn('worker', 'Failed to persist turn byok spend', { sessionId: sid, err: err.message });
    });
  }
}

// BYOK-billed cents the proxy observed for the session's most recent
// turn. Read by the turn-end settlement (limits.settleTurnSpend) AFTER
// execInWorker/resumeTurnFromJournal resolves — the registry entry
// survives the turn's finally block, and the next dispatch resets it.
function getTurnByokCents(sessionId) {
  const meta = _warmRegistry.get(Number(sessionId));
  return (meta && meta.turnByokCents) || 0;
}

// Flip the turn's "payer switched to BYOK" marker. Returns true exactly
// once per turn (the false→true transition) so the proxy emits its
// one-time in-chat notice on the first switched call only.
function markTurnByokSwitched(sessionId) {
  const sid = Number(sessionId);
  const meta = _warmRegistry.get(sid);
  if (meta && meta.turnByokSwitched) return false;
  _registryUpsert(sid, { turnByokSwitched: true });
  return true;
}

// ──────────────────────────────────────────────────────────────────────
// Liveness-watchdog strike accounting
// ──────────────────────────────────────────────────────────────────────
//
// isWorkerExecuting is tri-state: true (turn process present), false
// (definite idle — the probe ran and found no turn process), null (the
// probe ITSELF failed: docker exec timed out, daemon contended, spawn
// error). A null says nothing about the turn — auto-solve workloads
// routinely contend the docker daemon for tens of seconds — so probe
// failures must NOT count toward the cheap 2-strike idle abandonment.
// They get their own, much larger consecutive budget before the turn is
// declared unobservable. Extracted as pure helpers so the policy is
// unit-testable without docker.
const WATCHDOG_INTERVAL_MS = 10000;
// #889: once a stop has been requested for this session the probe cadence
// tightens. The normal 10s/2-strike budget exists for crashes and OOM kills,
// where a fast cadence would only pile `docker exec` load onto a contended
// daemon; a stop is a known-imminent death, so we can afford to look often.
// This is the FALLBACK — stopTurn appends the exit marker itself, which
// resolves the consumer in milliseconds. It only matters when that append
// failed (unknown journal path, container hiccup).
const WATCHDOG_STOP_INTERVAL_MS = 1000;
const WATCHDOG_PROBE_TIMEOUT_MS = 15000;
const WATCHDOG_IDLE_STRIKE_LIMIT = 2;
// After a stop, ONE definite idle is enough: the two-strike default exists
// to give the wrapper's final `echo >> journal` an interval to flush, and
// on the stop path the wrapper is dead before it can ever run that echo.
const WATCHDOG_STOP_IDLE_STRIKE_LIMIT = 1;
const WATCHDOG_PROBE_FAILURE_LIMIT = 12;
// After the watchdog abandons a tail, a `docker inspect` showing the
// container still running buys the turn another tail cycle (a
// late-arriving __USERNODE_EXIT__ marker is then consumed normally).
// Bounded so a permanently unobservable turn still resolves.
const WATCHDOG_MAX_RETAILS = 3;

function newWatchdogCounters() {
  return { idleStrikes: 0, probeFailures: 0 };
}

// Fold one probe result into the counters. Returns { abandon, cause }:
// abandon=true with 'turn_process_gone' after two consecutive definite
// idles (the wrapper's final `echo >> journal` gets one interval to
// flush), or with 'probe_unobservable' once the consecutive
// probe-failure budget is exhausted.
//
// `idleLimit` overrides the definite-idle strike budget — the caller passes
// WATCHDOG_STOP_IDLE_STRIKE_LIMIT once a stop has been requested (#889).
// The probe-failure budget is deliberately NOT tightened: a null still says
// nothing about the turn, stop requested or not.
function recordWatchdogProbe(counters, busy, { idleLimit = WATCHDOG_IDLE_STRIKE_LIMIT } = {}) {
  if (busy === true) {
    counters.idleStrikes = 0;
    counters.probeFailures = 0;
    return { abandon: false, cause: null };
  }
  if (busy === false) {
    counters.idleStrikes += 1;
    // The probe itself succeeded, so the consecutive-failure run ends.
    counters.probeFailures = 0;
    return counters.idleStrikes >= idleLimit
      ? { abandon: true, cause: 'turn_process_gone' }
      : { abandon: false, cause: null };
  }
  counters.probeFailures += 1;
  return counters.probeFailures >= WATCHDOG_PROBE_FAILURE_LIMIT
    ? { abandon: true, cause: 'probe_unobservable' }
    : { abandon: false, cause: null };
}

// Positive evidence of container death for the markerless-turn path.
// Returns { status, oomKilled } — status 'gone' when docker says the
// container doesn't exist — or null when inspect itself failed (daemon
// contended), i.e. we still don't know.
async function inspectContainerState(containerName) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.Status}} {{.State.OOMKilled}}', containerName,
    ], { timeout: WATCHDOG_PROBE_TIMEOUT_MS });
    const [status, oom] = stdout.trim().split(/\s+/);
    return { status: status || 'unknown', oomKilled: oom === 'true' };
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/no such (object|container)/i.test(msg)) return { status: 'gone', oomKilled: false };
    return null;
  }
}

// Follow a turn journal until the __USERNODE_EXIT__ marker lands (turn
// finished) or the turn process is verifiably gone (killed / OOM — no
// marker will ever come). Feeds every line through the shared parseLine
// state machine, so the resolved `state` matches the attached
// transport's shape exactly.
//
// The tail itself is a disposable `docker exec`; if it drops while the
// turn is still running (docker hiccup, etc.) we restart it and skip
// the lines we already consumed.
async function _consumeJournal(containerName, journal, progress, state, { sessionId = null, startedAt = null } = {}) {
  if (usesKubernetesWorkers()) {
    const since = startedAt || new Date().toISOString();
    let linesConsumed = 0;
    const counters = newWatchdogCounters();
    let lastProbeAt = Date.now();
    // WORKER_JWT_TTL is the jsonwebtoken duration string "24h". Use its
    // numeric twin for arithmetic; coercing the string produces NaN and
    // makes this loop return probe_unobservable before its first poll.
    const deadline = Date.now() + WORKER_JWT_TTL_MS;
    const readJournal = async () => {
      try {
        // Only the lines written since the last poll. Reading the whole
        // journal every second made each poll a fresh journal-sized string,
        // and a line sliced from it keeps that whole string alive inside
        // state.rawStdout: a long turn pinned one full copy per second of
        // output, and the platform ran out of heap (2026-09-25). Counting
        // lines rather than bytes cannot drift on multi-byte text.
        const { stdout } = await execWorkerCommand(containerName, ['tail', '-n', `+${linesConsumed + 1}`, journal]);
        // tail may race a writer halfway through a JSON record or marker.
        // Advance only past complete lines, including blank lines. The next
        // read starts at the first line not yet consumed, so no record (and
        // therefore no provider usage) is lost or replayed at a boundary.
        let start = 0;
        let newline;
        while ((newline = stdout.indexOf('\n', start)) !== -1) {
          const line = stdout.slice(start, newline);
          start = newline + 1;
          linesConsumed += 1;
          state.rawStdout += `${line}\n`;
          parseLine(line, progress, state);
          if (state.execExitSeen) return;
        }
      } catch (_) { /* journal may not exist yet */ }
    };
    while (Date.now() < deadline) {
      await readJournal();
      if (state.execExitSeen) return state;
      const stopRequested = sessionId != null && !!_registryGet(sessionId)?.stopRequestedAt;
      const interval = stopRequested ? WATCHDOG_STOP_INTERVAL_MS : WATCHDOG_INTERVAL_MS;
      if (Date.now() - lastProbeAt >= interval) {
        const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
        lastProbeAt = Date.now();
        const verdict = recordWatchdogProbe(counters, busy, {
          idleLimit: stopRequested ? WATCHDOG_STOP_IDLE_STRIKE_LIMIT : WATCHDOG_IDLE_STRIKE_LIMIT,
        });
        if (busy === null) {
          log.warn('worker', 'Turn liveness probe failed', { containerName, sessionId, journal,
            consecutiveFailures: counters.probeFailures });
        }
        if (verdict.abandon) {
          // The wrapper can append its terminal marker between the last
          // journal read and the idle probe. Give that durable result the
          // final word, even if the journal was empty until this point.
          await readJournal();
          if (state.execExitSeen) return state;
          state.exitCode = state.exitCode ?? -1;
          const termination = await kubernetes.inspectWorkerTermination(kubernetesWorkerConfig(), containerName, { since });
          // A normal terminal journal marker always wins. Pod OOM evidence
          // must belong to this turn; an earlier restart proves nothing.
          await readJournal();
          if (state.execExitSeen) return state;
          state.markerlessCause = termination?.oomKilled ? 'oom_killed'
            : termination && termination.status !== 'running' ? 'container_gone' : verdict.cause;
          return state;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    state.exitCode = -1;
    state.markerlessCause = 'probe_unobservable';
    return state;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let linesConsumed = 0;
  let retails = 0;
  // Why the watchdog killed the most recent tail, when it did.
  let watchdogCause = null;

  const consume = (line) => {
    state.rawStdout += `${line}\n`;
    parseLine(line, progress, state);
  };

  for (;;) {
    watchdogCause = null;
    const counters = newWatchdogCounters();
    await new Promise((resolve) => {
      // Wait for the wrapper to create the journal, then follow it from
      // the top. `exec tail` so the pid the shell reports is tail itself.
      const proc = spawn('docker', [
        'exec', containerName, 'sh', '-c',
        `n=0; while [ ! -f "${journal}" ]; do n=$((n+1)); [ "$n" -gt 300 ] && exit 86; sleep 0.1; done; exec tail -n +1 -f "${journal}"`,
      ]);

      let done = false;
      let buf = '';
      let skip = linesConsumed;
      let livenessTimer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (livenessTimer) clearTimeout(livenessTimer);
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      };

      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (skip > 0) { skip -= 1; continue; }
          linesConsumed += 1;
          consume(line);
          if (state.execExitSeen) return finish();
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('close', finish);
      proc.on('error', finish);

      // Watchdog: `tail -f` never exits on its own, so detect the case
      // where the turn died without writing the exit marker (stopTurn
      // pkill, OOM kill). The probe is purely a safety net — the journal
      // tail is the real-time channel — so the long timeout/interval is
      // harmless, and only DEFINITE idles use the cheap 2-strike
      // abandonment; probe failures get the larger budget above.
      //
      // #889: self-rescheduling rather than a fixed interval so the cadence
      // can tighten the moment a stop is requested (stopTurn stamps
      // `stopRequestedAt` on the registry entry). Re-read per tick — a stop
      // can land at any point during a long turn.
      const stopRequested = () =>
        sessionId != null && !!_registryGet(sessionId)?.stopRequestedAt;
      const armLiveness = () => {
        livenessTimer = setTimeout(tick, stopRequested()
          ? WATCHDOG_STOP_INTERVAL_MS
          : WATCHDOG_INTERVAL_MS);
        // Never hold the process open on a safety-net probe.
        livenessTimer.unref?.();
      };
      const tick = async () => {
        if (done) return;
        const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
        if (done) return;
        const verdict = recordWatchdogProbe(counters, busy, {
          idleLimit: stopRequested()
            ? WATCHDOG_STOP_IDLE_STRIKE_LIMIT
            : WATCHDOG_IDLE_STRIKE_LIMIT,
        });
        if (busy === null) {
          log.warn('worker', 'Turn liveness probe failed', {
            containerName, sessionId, journal,
            consecutiveFailures: counters.probeFailures,
          });
        }
        if (verdict.abandon) {
          watchdogCause = verdict.cause;
          return finish();
        }
        armLiveness();
      };
      armLiveness();
    });

    if (state.execExitSeen) return state;

    // Tail ended without an exit marker. If the turn is still running
    // (transient tail/docker failure), restart the tail; otherwise we
    // need positive evidence of death before giving up.
    const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
    if (busy === true) {
      await sleep(1000);
      continue;
    }

    // Verify against docker itself: if the container is still running
    // and no probe definitively saw the turn process gone, re-tail
    // (bounded) instead of abandoning a possibly-healthy turn. This also
    // lets a marker that lands seconds late be consumed normally instead
    // of racing the one-shot `cat` below.
    const inspected = await inspectContainerState(containerName);
    if (
      inspected && inspected.status === 'running' && !inspected.oomKilled
      && busy !== false && watchdogCause !== 'turn_process_gone'
      && retails < WATCHDOG_MAX_RETAILS
    ) {
      retails += 1;
      log.warn('worker', 'Turn unobservable but container still running — re-tailing journal', {
        containerName, sessionId, journal, retails, maxRetails: WATCHDOG_MAX_RETAILS,
      });
      await sleep(1000);
      continue;
    }

    // Final non-follow read to catch anything the tail missed, then
    // give up with whatever state we accumulated.
    try {
      const { stdout } = await docker.execFileAsync('docker', [
        'exec', containerName, 'cat', journal,
      ], { timeout: 10000 });
      const lines = stdout.split('\n');
      for (let i = linesConsumed; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        linesConsumed += 1;
        consume(line);
        if (state.execExitSeen) break;
      }
    } catch {
      // Container (or journal) gone — nothing more to read.
    }
    if (!state.execExitSeen && state.exitCode == null) {
      // Turn vanished without a marker: stopped, killed, or unobservable.
      state.exitCode = -1;
      if (inspected && inspected.oomKilled) {
        state.markerlessCause = 'oom_killed';
      } else if (inspected && inspected.status !== 'running') {
        // Covers 'gone' (no such container) and exited/dead containers.
        state.markerlessCause = 'container_gone';
      } else if (busy === false || watchdogCause === 'turn_process_gone') {
        // Definite idle — stopTurn kills and in-container OOM of the
        // wrapper both land here.
        state.markerlessCause = 'turn_process_gone';
      } else {
        state.markerlessCause = 'probe_unobservable';
      }
      log.warn('worker', 'Turn ended without an exit marker', {
        sessionId, containerName, journal, linesConsumed,
        cause: state.markerlessCause,
        inspect: inspected ? `${inspected.status} oom=${inspected.oomKilled}` : 'unavailable',
        retails,
      });
    }
    return state;
  }
}

// Stop the in-flight turn for a session by killing run-cc.sh + claude
// inside the container. The warm wrapper (sleep infinity) survives, so
// the container stays adoptable for the next dispatch.
//
// #889: the kill also takes out the detached wrapper shell (its cmdline
// contains `/usr/local/bin/run-cc.sh`, so it matches TURN_PROC_RE), which
// means the wrapper can never run its own `echo "__USERNODE_EXIT__ $?"`.
// Historically that left the journal consumer to discover the death via its
// 10s/2-strike liveness watchdog — a measured 18.8s of dead air between the
// click and the chat unwinding. So we write the marker ourselves: kill,
// wait (bounded) for the processes to actually go, SIGKILL any survivor,
// then append `__USERNODE_EXIT__ 143` to the turn journal. The consumer's
// `tail -f` picks it up on the next read and resolves in milliseconds.
//
// Killing BEFORE appending is what makes the append safe: the wrapper's
// `> "$TURN_JOURNAL"` fd is gone by then, so the marker can't interleave
// with a half-written agent line.
//
// `stopRequestedAt` on the registry entry tightens the watchdog cadence as
// a fallback for the case where this append doesn't land at all.
async function stopTurn(sessionId, { force = false } = {}) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerRuntimeName(sessionId);
  _registryUpsert(sessionId, { stopRequestedAt: Date.now() });
  const command = execWorkerCommand(containerName, ['sh', '-c',
    buildTurnStopScript(meta?.journal || null, { force }),
  ], null, { timeoutMs: force ? 5000 : 30000 });
  if (force) {
    const result = await command;
    return /__USERNODE_STOP_CONFIRMED__/.test(result?.stdout || '');
  }
  await command.catch(() => {});
  log.info('worker', 'Stop signal sent (in-container kill + journal exit marker)', {
    containerName, sessionId, journal: meta?.journal || '(discovered in-container)',
  });
}

// #937: the pending-stop record. `stopRequestedAt` is stamped by
// stopTurn() and read by three consumers — the journal consumer's
// tightened liveness cadence, execInWorker's pre-dispatch gate, and its
// post-dispatch re-arm. It must therefore OUTLIVE the dispatch it guards,
// which is why neither execInWorker's upsert nor its finally touches it
// anymore.
//
// These two functions are the only places it is read/reset from outside,
// so the "when does a pending stop expire?" rule lives in exactly one
// place: a stop is pending until a genuinely NEW turn begins. Callers:
// the chat handler when it registers a fresh stop handle, and sync-main
// before its own dispatch (a stale flag must never block a sync turn).
function clearPendingStop(sessionId) {
  const sid = Number(sessionId);
  if (!_warmRegistry.has(sid)) return;
  _registryUpsert(sid, { stopRequestedAt: null });
}

// Epoch ms of the pending stop for this session, or null when none is
// pending. Synchronous by design — the dispatch gate reads it inline.
function getPendingStop(sessionId) {
  return _warmRegistry.get(Number(sessionId))?.stopRequestedAt || null;
}

// #460: materialize the dispatching user's personal agent files into the
// warm worker's CC volume before a build/scout turn. Wipe-and-rewrite of
// two managed paths — ~/.claude/CLAUDE.md (user-level memory Claude Code
// loads natively) and ~/.claude/skills/ (personal skills) — so deletions
// in Settings take effect on the next dispatch. Both live OUTSIDE the
// repo checkout, so run-cc.sh's `git add -A` can never commit them.
//
// The script travels on the exec child's STDIN (contents base64-inlined
// within it), never as a CLI arg, so user file contents don't show up in
// `ps` or `docker inspect`. Callers treat failures as non-fatal: the
// dispatch proceeds without personal files rather than failing the turn.
async function syncUserAgentFiles(sessionId, files) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`syncUserAgentFiles: no warm worker registered for session ${sessionId}`);
  }
  const { buildSyncShellScript } = require('./user-agent-files');
  if (usesKubernetesWorkers()) {
    await execWorkerCommand(meta.containerName, ['sh', '-s'], buildSyncShellScript(files || []));
  } else {
    await docker.execShellStdin(meta.containerName, buildSyncShellScript(files || []), {
      timeoutMs: 20000, label: 'syncUserAgentFiles',
    });
  }
  log.info('worker', 'Personal agent files synced', {
    sessionId, count: (files || []).length,
  });
}

// Boot-time resume: pick an in-flight (or finished-while-we-were-down)
// turn back up from its journal. The caller (server.js adoption) owns
// post-turn processing and clearing chat_sessions.active_turn; this
// just replays/follows the journal and returns the watch state, exactly
// as if execInWorker had stayed attached the whole time.
async function resumeTurnFromJournal(sessionId, {
  journal,
  turnId = null,
  onProgress,
  byokCentsSoFar = 0,
  agentBackend = 'claude_code',
  // The persisted active_turn.harness (#3296). Absent on a record written
  // before harnesses existed, which was always a Codex OpenRouter turn.
  agentHarness = null,
  telemetryComponent = null,
  telemetryCorrelationId = null,
  telemetryAttemptNumber = null,
  telemetryRequestMode = null,
  telemetryRequestTextCharacters = null,
  telemetryRequestSystemCharacters = null,
  telemetryRequestPayloadCharacters = null,
  telemetryModelContextWindowTokens = null,
  telemetryModelMaxOutputTokens = null,
  requestedModel = null,
  startedAt = null,
  attemptNumber = 1,
  billingByok = false,
  providerWasDispatched = false,
} = {}) {
  if (!journal) throw new Error('resumeTurnFromJournal: journal path required');
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerRuntimeName(sessionId);
  // #664: seed the per-turn BYOK counters from the persisted active_turn
  // record (callers pass active_turn.byokCents) so post-restart switched
  // calls accumulate on top instead of restarting from zero, and the
  // one-time switch notice doesn't re-fire for an already-switched turn.
  const seedCents = Number(byokCentsSoFar) > 0 ? Number(byokCentsSoFar) : 0;
  _registryUpsert(sessionId, {
    inFlight: true, adopted: true,
    // Recovered proxy calls must keep mirroring BYOK spillover onto the
    // exact durable owner. Without this identity a second restart discards
    // every cent observed after the first recovery.
    activeTurnId: turnId || null,
    turnByokCents: seedCents, turnByokSwitched: seedCents > 0,
  });
  const state = newWatchState();
  state.turnId = turnId || null;
  state.liveSpendEnabled = agentBackend === 'claude_code' && meta?.activeTurnMode !== 'sync';
  workerProgress.setSpend(sessionId, null);
  state.hostSessionId = sessionId;
  state.hostContainerName = containerName;
  // An executing/tail phase proves dispatch. A legacy dispatch_pending row
  // is ambiguous after a crash; for that shape the consumed journal below
  // must provide evidence before telemetry may count an invocation.
  state.providerDispatched = providerWasDispatched === true;
  // Seed the backend so parseLine routes Codex JSONL correctly on
  // recovery too (review P4). The caller passes the persisted
  // session.agent_backend.
  state.agentBackend = agentBackend;
  const recoveredBackend = resolveTurnBackend(agentBackend, agentHarness);
  state.agentHarness = recoveredBackend.harness;
  state.telemetryDiagnosticsEnabled = !!llmTelemetry.collectionComponent(telemetryComponent);
  if (recoveredBackend.runsClaude) {
    state.providerRateLimitEventCount = 0;
    state.contextCompactionCount = 0;
  }
  if (recoveredBackend.isOpenRouter) state.providerRetryCount = 0;
  const physicalStartedAt = new Date(startedAt || Date.now());
  const safeStartedAt = Number.isFinite(physicalStartedAt.getTime())
    ? physicalStartedAt
    : new Date();
  // Journal replay has no trustworthy timestamp per JSONL event. Leaving the
  // first-output clock unavailable is more honest than measuring from the
  // original start to the instant a restarted host replays old output.
  state.providerStartedMs = null;
  state.requestMode = telemetryRequestMode;
  state.requestMessageCount = telemetryRequestTextCharacters == null ? null : 1;
  state.requestUserMessageCount = telemetryRequestTextCharacters == null ? null : 1;
  state.requestContentBlockCount = telemetryRequestTextCharacters == null ? null : 1;
  state.requestTextCharacters = telemetryRequestTextCharacters;
  state.requestUserTextCharacters = telemetryRequestTextCharacters;
  state.requestSystemCharacters = telemetryRequestSystemCharacters;
  state.requestPayloadCharacters = telemetryRequestPayloadCharacters
    ?? (telemetryRequestTextCharacters == null
      ? null
      : telemetryRequestTextCharacters + (telemetryRequestSystemCharacters || 0));
  state.modelContextWindowTokens = telemetryModelContextWindowTokens;
  state.modelMaxOutputTokens = telemetryModelMaxOutputTokens;
  if (requestedModel) state.providerModelCount = 1;
  let providerTerminalObserved = false;
  try {
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId, startedAt: safeStartedAt });
    if (state.rawStdout || state.execExitSeen) state.providerDispatched = true;
    providerTerminalObserved = true;
    // The recovery caller owns required persistence (thread id + ledger)
    // and calls finishTurn only after it succeeds. Deleting here used to
    // destroy the sole replay source before those writes had landed.
    return finalizeHarnessResult(state);
  } finally {
    if (providerTerminalObserved && state.providerDispatched
        && resolveTurnBackend(agentBackend).isClaude && telemetryComponent && turnId) {
      recordClaudeCodingRun({
        sessionId,
        turnId,
        result: state,
        requestedModel,
        component: telemetryComponent,
        startedAt: safeStartedAt,
        durationMs: Math.max(0, Date.now() - safeStartedAt.getTime()),
        directByok: !!billingByok,
        byokCents: getTurnByokCents(sessionId),
        attemptNumber: Number(telemetryAttemptNumber) || Number(attemptNumber) || 1,
        correlationId: telemetryCorrelationId || String(turnId),
      });
    }
    _registryUpsert(sessionId, { inFlight: false, lastUsedMs: Date.now() });
  }
}

// Tear down a warm worker container (eviction). Volume is preserved so
// the next `ensureWorker` re-warms with CC's session memory intact.
async function evictWorker(sessionId) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  if (usesKubernetesWorkers()) {
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), sessionId, { deleteVolume: false }).catch(() => {});
  } else {
    await docker.stopAndRemove(containerName).catch(() => {});
  }
  _warmRegistry.delete(sessionId);
  log.info('worker', 'Worker evicted (volume preserved)', { containerName });
}

// ──────────────────────────────────────────────────────────────────────
// Legacy single-shot helpers (kept for orphan adoption + back-compat)
// ──────────────────────────────────────────────────────────────────────

// Tail a worker container's logs until the container exits, parsing
// stream-json + USERNODE markers along the way. Resolves with the
// accumulated state when the container is gone.
//
// Used today only by the orphan-adoption recovery path
// (recoverActiveWorkers in server.js). The live per-turn path uses
// execInWorker which streams the docker-exec child's stdout directly.
async function watchWorker(containerName, { onProgress, fromStart = true } = {}) {
  if (usesKubernetesWorkers()) {
    throw new Error('Kubernetes worker recovery requires a turn journal; legacy Docker log recovery is unavailable');
  }
  const state = newWatchState();
  state.hostContainerName = containerName;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const args = ['logs', '-f'];
  if (!fromStart) args.push('--tail', '0');
  args.push(containerName);

  const proc = spawn('docker', args);

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStdout += text;
    stdoutBuf += text;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) parseLine(line, progress, state);
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStderr += text;
    stderrBuf += text;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() && line.length < 500) progress(line);
    }
  });

  await new Promise((resolve) => {
    proc.on('close', resolve);
    proc.on('error', (err) => {
      log.warn('worker', 'docker logs -f errored', { containerName, err: err.message });
      resolve();
    });
  });

  if (stdoutBuf.trim()) parseLine(stdoutBuf, progress, state);

  // Grab the real exit code from docker itself; the __USERNODE_RESULT__
  // line is best-effort and could be absent (e.g. OOM kill).
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.ExitCode}}', containerName,
    ], { timeout: 5000 });
    state.exitCode = parseInt(stdout.trim(), 10);
  } catch {
    state.exitCode = -1;
  }

  return state;
}

// Return metadata for every container matching `usernode-worker-*`.
// Used on server startup to adopt any workers left over from a previous
// process. The state field comes straight from `docker ps`:
//   - "running"  : either a warm-idle wrapper (sleep infinity) or a
//                  legacy single-shot still in flight.
//   - "exited"   : single-shot finished; needs log scrape + cleanup.
//   - "created"/"restarting"/etc.: rare, treat as broken → reap.
async function listOrphanWorkers() {
  if (usesKubernetesWorkers()) return kubernetes.listWorkers(kubernetesWorkerConfig());
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'ps', '-a',
      '--filter', 'name=^/usernode-worker-',
      '--format', '{{.Names}}\t{{.State}}',
    ], { timeout: 5000 });
    const out = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, state] = line.split('\t');
      const m = name && name.match(/^usernode-worker-(\d+)$/);
      if (m) out.push({ name, sessionId: parseInt(m[1], 10), state });
    }
    return out;
  } catch {
    return [];
  }
}

// Match a turn process (run-cc.sh wrapper, run-cc.sh itself, or the
// claude CLI) by full cmdline. The anchors keep paths like
// /home/node/.claude/turn-X.log (our tail/cat execs) from matching —
// "claude" there is preceded by "." and followed by "/", neither of
// which the pattern accepts. The probe scripts below also exclude
// their own pid, and their script text can't self-match ("run-cc\.sh"
// in the text has a literal backslash; "claude" is preceded by "(").
//
// IMPORTANT: these walk /proc with sh + grep instead of pgrep/pkill —
// the worker image (node:22-bookworm-slim) does NOT ship procps, so
// pgrep/pkill exit 127 in there. The old `pgrep ... && busy || idle`
// one-liner silently reported "idle" for every container, busy or not.
// Match a turn process for EITHER backend (review F4): the Claude runner
// (run-cc.sh + claude) or the Codex runner, its request adapter, and codex.
// Without the codex terms, long Codex turns look idle (watchdog abandons)
// and Stop appends a fake marker without killing the process.
// #3296 adds the Claude-over-OpenRouter request adapter that wraps claude.
const TURN_PROC_RE = '(^|[ /])(claude|run-cc\\.sh|codex|run-codex-agent\\.sh|codex-openrouter-request\\.js|claude-openrouter-request\\.js)( |$)';
const TURN_PROC_PROBE_SCRIPT =
  'busy=0; for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && { busy=1; break; }; `
  + 'done; [ "$busy" = "1" ] && echo busy || echo idle';
// Signal every turn process in the container. Same /proc walk as the probe
// above (procps isn't in the worker image, so pgrep/pkill are unavailable).
// Skips its own shell so the script can't signal itself.
const turnProcSignalSnippet = (sig) =>
  'for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && kill -${sig} "\${d#/proc/}" 2>/dev/null; `
  + 'done';

// True (`alive=1`) while any turn process is still in the container — the
// SIGTERM grace loop polls this to find out when the last one is gone.
const turnProcAliveSnippet =
  'alive=0; for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && { alive=1; break; }; `
  + 'done';

// #889: how long the in-container stop waits for a SIGTERMed turn process
// to actually exit before escalating to SIGKILL. 20 × 100ms. Sized so a
// well-behaved `claude` gets a real chance to flush and exit cleanly while
// the whole stop still lands inside a couple of seconds.
const TURN_STOP_GRACE_TICKS = 20;

// The full in-container stop procedure, as ONE `sh -c` so a stop costs a
// single `docker exec`: SIGTERM the turn processes → poll /proc until they
// are gone (bounded) → SIGKILL the stragglers → append the exit marker to
// the turn journal so the host-side consumer resolves immediately.
//
// `journal` is the host's recorded path for the in-flight turn. When it is
// unknown (an adopted worker whose registry entry predates this dispatch)
// the script discovers the newest turn journal itself — the dispatch
// wrapper rm's stale ones first, so at most one exists. Classic stops are
// best-effort; force stops must return confirmation or fail for recovery.
function buildTurnStopScript(journal, { force = false } = {}) {
  const journalExpr = journal
    // Single-quoted: the path is platform-generated (/home/node/.claude/
    // turn-<ms>.log), never user input, and quoting keeps it one word.
    ? `J='${journal}'`
    : 'J=$(ls -t /home/node/.claude/turn-*.log 2>/dev/null | head -1)';
  if (force) return buildImmediateTurnStopScript(journalExpr);
  return [
    turnProcSignalSnippet('TERM'),
    // Wait for the SIGTERMed processes to actually disappear. Breaks out on
    // the first clean scan, so the common case costs no wall-clock at all.
    `i=0; while [ "$i" -lt ${TURN_STOP_GRACE_TICKS} ]; do `
      + `${turnProcAliveSnippet}; `
      + '[ "$alive" = "0" ] && break; i=$((i+1)); sleep 0.1; done',
    // Anything still standing ignored SIGTERM — take it out hard, so the
    // marker below is written against a genuinely dead turn.
    turnProcSignalSnippet('KILL'),
    journalExpr,
    // 143 = 128 + SIGTERM, what a docker-stop-based kill would have produced.
    '[ -n "$J" ] && [ -f "$J" ] && echo "__USERNODE_EXIT__ 143" >> "$J" 2>/dev/null',
    'exit 0',
  ].join('; ');
}

// Hard cancellation preserves the warm worker and workspace. Freeze the
// owned roots before walking descendants so a stopped parent cannot fork
// fresh tools while we terminate its process tree. The warm idle wrapper,
// journal reader and this control shell are not roots.
function buildImmediateTurnStopScript(journalExpr) {
  return [
    'targets=" "',
    'for d in /proc/[0-9]*; do '
      + '[ "$d" = "/proc/$$" ] && continue; '
      + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
      + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' || continue; `
      + 'p=${d#/proc/}; targets="$targets$p "; kill -STOP "$p" 2>/dev/null; done',
    'added=1; while [ "$added" = 1 ]; do added=0; '
      + 'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; '
      + 'case "$targets" in *" $p "*) continue;; esac; '
      + 'parent=$(sed -n "s/^PPid:[[:space:]]*//p" "$d/status" 2>/dev/null); '
      + '[ -n "$parent" ] || continue; '
      + 'case "$targets" in *" $parent "*) targets="$targets$p "; added=1; kill -STOP "$p" 2>/dev/null;; esac; '
      + 'done; done',
    'for p in $targets; do kill -KILL "$p" 2>/dev/null; done',
    // Do not write a terminal marker while any signalled process can run.
    // A zombie has already exited; reaping it belongs to its parent.
    'i=0; while :; do alive=0; for p in $targets; do '
      + '[ -r "/proc/$p/stat" ] || continue; '
      + 'state=$(sed "s/^.*) //" "/proc/$p/stat" 2>/dev/null); '
      + 'case "$state" in Z*|X*|"") ;; *) alive=1;; esac; done; '
      + '[ "$alive" = 0 ] && break; [ "$i" -ge 10 ] && exit 75; '
      + 'i=$((i+1)); sleep 0.05; done',
    journalExpr,
    '[ -n "$J" ] && [ -f "$J" ] && echo "__USERNODE_EXIT__ 137" >> "$J" 2>/dev/null',
    'echo __USERNODE_STOP_CONFIRMED__',
  ].join('; ');
}

// Best-effort check of whether a running warm container has an in-flight
// per-turn exec. We look for a turn process inside the container — the
// sleep wrapper is always there, but run-cc.sh/claude are only present
// while a turn is executing.
//
// Returns:
//   true   — claude (or its parent run-cc.sh) is currently executing
//   false  — no turn is executing, or Kubernetes confirms no worker exists
//   null   — couldn't determine (worker unready, exec/API failed, etc.)
//
// `timeoutMs` is overridable because the journal watchdog deliberately
// runs the probe with a generous timeout (the probe is a safety net, not
// the real-time channel); other callers keep the snappy default.
async function isWorkerExecuting(containerName, { timeoutMs = 5000 } = {}) {
  try {
    const { stdout } = usesKubernetesWorkers()
      ? await execWorkerCommand(containerName, ['sh', '-c', TURN_PROC_PROBE_SCRIPT], null, { timeoutMs })
      : await docker.execFileAsync('docker', [
          'exec', containerName, 'sh', '-c', TURN_PROC_PROBE_SCRIPT,
        ], { timeout: timeoutMs });
    const out = stdout.trim();
    if (out === 'busy') return true;
    if (out === 'idle') return false;
    return null;
  } catch (err) {
    if (usesKubernetesWorkers() && err.code === 'WORKER_NOT_FOUND') return false;
    return null;
  }
}

async function getWorkerStatus(containerName) {
  return usesKubernetesWorkers()
    ? kubernetes.getWorkerStatus(kubernetesWorkerConfig(), containerName)
    : docker.getContainerStatus(containerName);
}

// Legacy stop handles still exist during recovery. Kubernetes has no Docker
// stop operation: remove the worker Deployment, preserving its workspace.
async function stopWorker(containerName) {
  if (usesKubernetesWorkers()) return destroyWorker(containerName);
  await docker.execFileAsync('docker', ['stop', containerName], { timeout: 15000 });
}

// Hard teardown of a worker container. Used for session archive, error
// recovery, and the orphan-adoption legacy path. Removes the registry
// entry too so a follow-up ensureWorker doesn't trust stale state.
//
// For ordinary idle eviction during a session, use `evictWorker`
// instead — same effect, but the function name signals intent better.
async function destroyWorker(containerName) {
  const m = containerName.match(/(?:usernode-worker-|sv-worker-s)(\d+)$/);
  if (usesKubernetesWorkers()) {
    if (!m) throw new Error(`Invalid Kubernetes worker name: ${containerName}`);
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), parseInt(m[1], 10), { deleteVolume: false }).catch(() => {});
  } else {
    await docker.stopAndRemove(containerName).catch(() => {});
  }
  if (m) _warmRegistry.delete(parseInt(m[1], 10));
  log.info('worker', 'Worker destroyed', { containerName });
}

// Account erasure must not use the best-effort archive helpers: a failed
// runtime/volume removal remains a durable retry task.
async function eraseAccountWorkspace(sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('invalid_session');
  if (usesKubernetesWorkers()) {
    await kubernetes.eraseWorker(kubernetesWorkerConfig(), sessionId);
  } else {
    const result = await docker.stopAndRemove(workerContainerName(sessionId));
    if (!result.removed) throw new Error('worker_removal_failed');
    try {
      await docker.execFileAsync('docker', ['volume', 'rm', '-f', ccVolumeName(sessionId)], { timeout: 10000 });
    } catch (err) {
      if (!/no such volume/i.test(String(err.stderr || err.message))) throw new Error('volume_removal_failed');
    }
  }
  _warmRegistry.delete(sessionId);
}

// Remove the named CC volume for a given chat session. Called when the
// session is archived (permanent teardown). Safe to call even if the
// volume was never created.
async function destroyCcVolume(sessionId) {
  if (usesKubernetesWorkers()) {
    await kubernetes.deleteWorker(kubernetesWorkerConfig(), sessionId, { deleteVolume: true });
  } else {
    await docker.removeVolume(ccVolumeName(sessionId));
  }
  _warmRegistry.delete(sessionId);
}

// Kubernetes worker state volumes, one per change (see
// worker-volume-reclaim.js). A Docker host has no volume quota to manage.
async function listWorkerVolumes() {
  if (!usesKubernetesWorkers()) return [];
  return kubernetes.listWorkerVolumes(kubernetesWorkerConfig());
}

// #155: copy one session's CC memory volume (~/.claude) into another
// session's volume, so a dev chat cloned from a headless auto session can
// `--resume` the auto session's Claude Code conversation. Uses the worker
// image (always present locally — staging/CC builds keep it warm) for the
// one-shot copy container, so no registry pull is needed. Throws when the
// source volume doesn't exist or the copy fails; callers treat a clone
// failure as "start with fresh CC memory" (cc_session_id stays NULL).
async function cloneCcVolume(srcSessionId, destSessionId) {
  if (usesKubernetesWorkers()) {
    await kubernetes.cloneWorkerVolume(kubernetesWorkerConfig(), srcSessionId, destSessionId);
    log.info('worker', 'CC PVC cloned', { from: srcSessionId, to: destSessionId });
    return;
  }
  const src = ccVolumeName(srcSessionId);
  const dest = ccVolumeName(destSessionId);
  // Throws if the source volume was never created (e.g. the headless run
  // failed before its first worker bootstrap).
  await docker.execFileAsync('docker', ['volume', 'inspect', src], { timeout: 5000 });
  await docker.ensureVolume(dest);
  // Run the copy as root (`--user 0:0`). A freshly-created named volume is
  // owned root:root (0755), but the worker image's default user is non-root,
  // so a non-root copy container can't create entries under /to — the exact
  // failures seen cloning chat 735 ("cp: cannot create directory
  // '/to/./backups': Permission denied", "cp: preserving times for '/to/.':
  // Operation not permitted"), which left the clone with fresh CC memory.
  // `cp -a` still preserves each source entry's original uid/gid, so the
  // worker user can read its own ~/.claude files afterward.
  await docker.execFileAsync('docker', [
    'run', '--rm',
    '--user', '0:0',
    '-v', `${src}:/from:ro`,
    '-v', `${dest}:/to`,
    '--entrypoint', 'sh',
    WORKER_IMAGE,
    '-c', 'cp -a /from/. /to/',
  ], { timeout: 60000 });
  log.info('worker', 'CC volume cloned', { from: src, to: dest });
}

// ──────────────────────────────────────────────────────────────────────
// Platform-side git push proxy
// ──────────────────────────────────────────────────────────────────────
//
// The worker container carries no GitHub credentials. When CC commits
// and wants to push, the worker's `usernode-push` shell wrapper hits
// POST /api/internal/sessions/:id/push (see src/routes/internal.js),
// which calls this helper.
//
// We use the worker's existing clone (origin already points at GitHub)
// and inject `GITHUB_BOT_TOKEN` into a single one-shot `docker exec` via
// an inline credential helper. The bot token never enters the worker's
// persistent env or git config; it lives in the exec's environ for the
// duration of the push and disappears when the exec exits.
//
// Branch is supplied by the caller (the route handler) AFTER looking up
// the session's canonical `branch_name` from the DB. The worker doesn't
// get to pick. Branch is checked against a strict charset before being
// passed to bash so it can't break out of the shell expansion below.
//
// #1376: that charset lives in services/branch-names.js now, shared with
// the routes that MINT the name. It used to be defined only here and
// excluded `@`, which every email-address username produces — so those
// sessions committed fine and then failed every push, heal included.

async function execPushFromWorker(sessionId, branchName) {
  const botToken = process.env.GITHUB_BOT_TOKEN || '';
  if (!botToken) {
    const err = new Error('GITHUB_BOT_TOKEN not configured on platform');
    err.code = 'no_token';
    // Also permanent — no amount of retrying conjures a bot token.
    err.permanent = true;
    err.userMessage =
      'The platform has no GitHub bot token configured, so it cannot push on '
      + "your behalf. This needs a platform admin, and retrying won't help.";
    throw err;
  }
  // #1350: a session created but never given a turn has no branch at all,
  // so the push proxy has to name that case separately. Left to fall
  // through, isValidBranchName rejects null and the message advises
  // renaming a branch that does not exist, which is advice nobody can act
  // on. The remedy is to run a turn.
  if (branchName == null || branchName === '') {
    const err = new Error(`Session ${sessionId} has no branch yet`);
    err.code = 'no_branch';
    err.permanent = true;
    err.userMessage =
      'This session does not have a git branch yet, so there is nothing to push to. '
      + 'Send a message in the session first. Homeroom creates the branch on the '
      + 'first turn and the push will work from then on.';
    throw err;
  }
  if (!branchNames.isValidBranchName(branchName)) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = 'bad_branch';
    // Permanent for this session: retrying pushes the same rejected name.
    err.permanent = true;
    err.userMessage =
      `This session's branch name (${branchName}) isn't a valid git branch, `
      + 'so the push can never succeed. Start a new session on this app '
      + '(its branch will be named correctly), or ask an admin to rename this one.';
    throw err;
  }

  const containerName = _registryGet(sessionId)?.containerName || workerRuntimeName(sessionId);

  // Inline credential helper: prints `username=x-access-token` and
  // `password=$PAT` to stdout when git asks for credentials. `-c
  // credential.helper=…` is scoped to this single git invocation —
  // doesn't touch the worker's .git/config. The `bash -c` script
  // reads $PAT and $BRANCH from the exec env (passed via bare `-e`
  // so the values aren't in argv).
  //
  // Final `git rev-parse HEAD` prints the SHA we pushed, which the
  // caller surfaces back to the worker for logging and the
  // __USERNODE_RESULT__ accounting.
  const inlineScript =
    'set -e; cd /home/node/workspace && ' +
    'git -c credential.helper="!f() { echo username=x-access-token; echo password=$PAT; }; f" ' +
    'push -u origin "$BRANCH" >&2 && ' +
    'git rev-parse HEAD';

  const args = [
    'exec',
    '-e', 'PAT',              // bare -e: value taken from docker's own env
    '-e', 'BRANCH',
    containerName,
    'bash', '-c', inlineScript,
  ];

  try {
    let stdout;
    let stderr;
    if (usesKubernetesWorkers()) {
      const script = `export PAT=${shellQuote(botToken)}\nexport BRANCH=${shellQuote(branchName)}\n${inlineScript}\n`;
      ({ stdout, stderr } = await execWorkerCommand(containerName, ['bash', '-s'], script, { timeoutMs: 60000 }));
    } else {
      ({ stdout, stderr } = await docker.execFileAsync('docker', args, {
        timeout: 60000,
        env: { ...process.env, PAT: botToken, BRANCH: branchName },
      }));
    }
    const sha = (stdout || '').trim().split('\n').pop();
    log.info('worker', 'Push proxied to GitHub', {
      sessionId, branch: branchName, sha: (sha || '').slice(0, 8),
    });
    return { sha, stderr: (stderr || '').trim() };
  } catch (err) {
    // Don't leak the PAT into log lines if `docker exec` printed any
    // (it shouldn't — credential helpers don't echo creds — but defense
    // in depth). err.message + err.stderr come from execFileAsync.
    const cleanMsg = String(err.message || '').replace(botToken, '***');
    const cleanStderr = String(err.stderr || '').replace(botToken, '***');
    const wrapped = new Error(`push proxy failed: ${cleanMsg}`);
    wrapped.code = 'push_failed';
    wrapped.stderr = cleanStderr;
    log.warn('worker', 'Push proxy failed', {
      sessionId, branch: branchName, err: cleanMsg,
    });
    throw wrapped;
  }
}

/**
 * #1376: turn an execPushFromWorker rejection into something a dev-chat
 * reader can act on. The old copy was one fixed sentence ending "Retry
 * your request to re-push" — which for a `bad_branch` session is advice
 * that can only ever fail again, and which hid the actual reason in a
 * platform WARN line nobody outside the container ever sees.
 *
 * Returns `{ text, permanent, code }`. `permanent` marks failures where
 * retrying is provably useless, so callers can stop suggesting it.
 */
function describePushFailure(err) {
  const code = err?.code || 'push_failed';
  const permanent = err?.permanent === true;
  const lead = "Push to GitHub failed. Your changes are committed in the "
    + "session's worker but not on GitHub.";

  if (err?.userMessage) {
    return { text: `${lead} ${err.userMessage}`, permanent, code };
  }

  const detail = String(err?.message || '').trim();
  const reason = detail ? ` (${detail.substring(0, 200)})` : '';
  return {
    text: `${lead}${reason} Retry your request to re-push and open the PR.`,
    permanent: false,
    code,
  };
}

module.exports = {
  usesKubernetesWorkers,
  getWorkerStatus,
  stopWorker,
  describePushFailure,
  ensureWorkerImage,
  // long-lived API
  ensureWorker,
  // Cold-bootstrap failure classification. The route layer uses
  // isBootstrapError to tell "the coding agent never started" apart from
  // "the coding agent ran and failed" — the two need very different copy.
  isBootstrapError,
  isRetryableBootstrapError,
  execInWorker,
  stopTurn,
  // #937: pending-stop record (survives the dispatch it guards)
  clearPendingStop,
  getPendingStop,
  syncUserAgentFiles,
  resumeTurnFromJournal,
  clearActiveTurn,
  // post-agent tail lifecycle (holdTurnRecord callers)
  TURN_PHASE_TAIL,
  markTurnTail,
  noteTailMilestone,
  markTurnRetryPending,
  finishTurn,
  isTailPhase,
  evictWorker,
  warmRegistrySnapshot,
  adoptWarmWorker,
  isInFlight,
  isWorkerExecuting,
  getActiveTurnMode,
  // #664: per-turn BYOK spillover accounting (worker Anthropic proxy +
  // turn-end settlement)
  noteTurnByokSpend,
  getTurnByokCents,
  markTurnByokSwitched,
  // legacy / shared helpers
  watchWorker,
  listOrphanWorkers,
  destroyWorker,
  destroyCcVolume,
  listWorkerVolumes,
  eraseAccountWorkspace,
  setAccountDeletionGuard,
  cloneCcVolume,
  parseClaudeResponse,
  // exposed for unit tests (watchdog strike policy + line parsing)
  newWatchState,
  _recordClaudeCodingRunForTests: recordClaudeCodingRun,
  parseLine,
  newWatchdogCounters,
  recordWatchdogProbe,
  WORKER_JWT_TTL_MS,
  // #889: in-container stop procedure (exported for tests)
  buildTurnStopScript,
  // exposed for the routes' container-name lookups
  workerContainerName,
  workerRuntimeName,
  // platform-side git push proxy (called from src/routes/internal.js)
  execPushFromWorker,
  mintWorkerJwt,
  mintAnthropicProxyJwt,
  // #616: prod-debug JWT + pure turn-env builder (exported for tests)
  mintProdDebugJwt,
  mintShotsJwt,
  shotsControlUrl,
  claudeTurnModel,
  buildTurnSecretEnv,
  // #3296: harness-aware backend resolution and result shape (for tests)
  resolveTurnBackend,
  finalizeHarnessResult,
  // file-based dispatch-prompt transport (E2BIG fix; exported for tests)
  TURN_PROMPT_PATH,
  TURN_SYSTEM_PROMPT_PATH,
  TURN_RESUME_FALLBACK_PROMPT_PATH,
  buildTurnPromptScript,
  buildTurnSystemPromptScript,
  buildTurnResumeFallbackPromptScript,
  writeTurnPrompt,
  writeTurnSystemPrompt,
  writeTurnResumeFallbackPrompt,
};
