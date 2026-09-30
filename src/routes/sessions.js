'use strict';

const express = require('express');
const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const proposalUpdate = require('../services/proposal-update');
const webFetch = require('../services/web-fetch');
const prMetadata = require('../services/pr-metadata');
const sessionTitles = require('../services/session-title');
const testingNotes = require('../services/testing-notes');
const proposalDescription = require('../services/proposal-description');
const staging = require('../services/staging');
const topicAttrs = require('../services/topic-attributes');
const agentSessions = require('../services/agent-sessions');
const { claimIssueForUser } = require('../services/issue-claims');
const { appIdentityEnv } = require('../services/app-identity-env');
const visuals = require('../services/visuals');
const docker = require('../services/docker');
const applicationRuntime = require('../services/application-runtime');
const caddy = require('../services/caddy');
const worker = require('../services/worker');
const branchNames = require('../services/branch-names');
const agentTurn = require('../services/agent-turn');
const registry = require('../agents/registry');
const agentPreferences = require('../services/agent-preferences');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const openRouterMayor = require('../services/openrouter-mayor');
const codexOpenRouter = require('../agents/codex-openrouter');
const { MIN_MAX_OUTPUT_TOKENS } = require('../../worker/build-codex-model-catalog');
const workerProgress = require('../services/worker-progress');
const sessionLifecycle = require('../services/session-lifecycle');
const stagingRecovery = require('../services/staging-recovery');
const sessionBus = require('../services/session-bus');
const chatDelivery = require('../services/chat-delivery');
const { drainGuard } = require('../services/lifecycle');
const unitSuiteRow = require('../services/unit-suite-row');
const {
  getAppConventions,
  getSelfHostedRefuseList,
  getDesignGuidance,
  SPEC_DESIGN_BRIEF,
} = require('../services/prompts');
const {
  IN_LOOP_BROWSER_GUIDANCE,
  HOSTED_CLAUDE_IN_LOOP_BROWSER_GUIDANCE,
} = require('../services/in-loop-browser');
const models = require('../services/models');
const limits = require('../services/limits');
const { effectiveSessionCaps } = require('../services/session-caps');
const events = require('../services/events');
const modelFallback = require('../services/model-fallback');

// Imported pull requests are proposal-shaped work before they are promoted:
// their GitHub description, testing notes, check run and community attributes
// already exist, even though their lifecycle status is still active/paused.
// The ordinary session list deliberately stays lightweight and private, so
// enrich only imported Underway rows in a second, id-scoped read after the
// owner/shared visibility query has selected which rows the viewer may see.
// The opened detail uses the same public projection for any visible change;
// `all` is set only AFTER the per-session privacy gate, never on a board list.
async function enrichImportedUnderwaySessions(pool, sessions, viewerUserId, { all = false } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const ids = list
    .filter((s) => s && (all || (s.source === 'imported'
      && (s.status === 'active' || s.status === 'paused'))))
    .map((s) => Number(s.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return list;

  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.pr_number, cs.pr_url, cs.pr_title,
            cs.pr_title_fallback, cs.pr_summary_md, cs.pr_summary_stale, cs.pr_body, cs.branch_name,
            cs.staging_url, cs.testing_md, cs.testing_path, cs.testing_paths,
            cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
            cs.source, cs.imported_pr_author, cs.imported_pr_head_repo,
            cs.imported_pr_head_sha, cs.reviewed_head_sha, cs.handoff_head_sha,
            cs.external_agent,
            cs.merge_conflict_state, cs.behind_main, cs.conflict_files,
            cs.conflict_checked_at, cs.console_check_state, cs.console_errors,
            cs.console_checked_at, cs.check_state, cs.test_results,
            cs.checks_checked_at, cs.checks_commit_sha, cs.checks_base_sha,
            cs.checks_base_verdict, cs.checks_base_behind_by,
            cs.mergeability, cs.mergeability_files,
            cs.mergeability_files_complete, cs.freshness_main_sha,
            cs.freshness_merge_base_sha, cs.freshness_behind_by,
            cs.freshness_ahead_by, cs.freshness_checked_at,
            cs.freshness_error, cs.check_phase, cs.check_trigger, cs.checks_progress,
            cs.platform_env_state, cs.platform_env_detail,
            cs.check_error_detail, cs.requires_explicit_approval,
            (SELECT jsonb_object_agg(
                      sv.kind || '_' || sv.capture_index || '_' || sv.media,
                      jsonb_build_object(
                        'id', sv.id,
                        'path', sv.captured_path,
                        'viewport', sv.captured_viewport,
                        'commit', sv.commit_hash,
                        'scenarioId', sv.scenario_id,
                        'scenarioFingerprint', sv.scenario_fingerprint,
                        'fellBack', sv.before_fell_back))
               FROM session_visuals sv WHERE sv.session_id = cs.id) AS visuals_agg
       FROM chat_sessions cs
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = ANY($1::int[])
        AND ($2::boolean OR (cs.source = 'imported'
        AND cs.status IN ('active', 'paused')))`,
    [ids, all]
  );

  const rowsByApp = new Map();
  for (const row of rows) {
    if (!rowsByApp.has(row.app_id)) rowsByApp.set(row.app_id, []);
    rowsByApp.get(row.app_id).push(row);
  }

  const attrsById = new Map();
  for (const [appId, appRows] of rowsByApp) {
    const summaries = await topicAttrs.summarizeForProposals(
      pool,
      appId,
      appRows.map((row) => ({ id: row.id, linked_issues: row.linked_issues })),
      viewerUserId || null
    );
    for (const row of appRows) {
      attrsById.set(row.id, summaries.get(row.id) || topicAttrs.emptySummary());
    }
  }

  const detailsById = new Map();
  for (const row of rows) {
    const attrs = attrsById.get(row.id) || topicAttrs.emptySummary();
    const detail = {
      ...row,
      visuals: visuals.shapeAgg(row.visuals_agg, visualHeadForSession(row)),
      ...staging.previewDisplayState(row),
      priority: attrs.priority,
      assignee: attrs.assignee,
      category: attrs.category,
    };
    delete detail.app_id;
    delete detail.visuals_agg;
    detailsById.set(row.id, detail);
  }

  return list.map((session) => {
    const detail = detailsById.get(session.id);
    return detail ? { ...session, ...detail } : session;
  });
}

// The six build venues (#1281). The browser's copy is VENUES in
// public/js/build-venues.js and it is the authoritative list; this is the
// server-side domain for chat_sessions.build_venue, and
// tests/build-venue-route.test.js scrapes that file to keep the two in
// step, the same way tests/dev-flow-preference.test.js pins the three
// dev_flow_preference values across their three homes. The CHECK
// constraint in schema.sql is the third copy and the last line of defence.
const BUILD_VENUES = [
  'usernode-claude', 'usernode-openrouter', 'local',
  'web-claude-code', 'web-codex', 'own-tools-pr',
];
const { getActiveUserStats } = require('../services/active-users');
const { chatLimiter, attachmentUploadLimiter } = require('../middleware/rate-limits');
const attachmentsSvc = require('../services/attachments');
const { listDrafts } = require('./chat-drafts');
// Read-only transcript sharing: the deny-by-default row/metadata allowlist
// shared by GET /transcript and POST /fork (see services/transcript-share.js).
const transcriptShare = require('../services/transcript-share');
const appAccess = require('../services/app-access');
const listTestResults = require('../services/list-test-results');
const communities = require('../services/communities');
const userAgentFiles = require('../services/user-agent-files');
const debugAccess = require('../services/debug-access');
// #907: a coding agent running on the user's own machine, holding a lease on
// this session. When one is attached, runClaudeCodeTool dispatches the turn to
// it instead of to a worker container; everything after the commit — PR,
// staging, checks, visuals — is the same tail.
const localAgent = require('../services/local-agent');
const localAgentDemo = require('../services/local-agent-demo');
// #1417: the viewer's open connector work orders, read for the Improve
// panel alongside their sessions. Owns external_agent_tasks, so the query
// lives there rather than being restated here.
const { listOpenWorkOrders } = require('../services/external-agent-tasks');
// #945: Homeroom-side issue / proposal discussion threads as agent
// context. Every loader here degrades to an empty result, so a failed
// lookup drops the block rather than failing the turn.
const threadContext = require('../services/thread-context');
// Backs the Mayor's get_prod_status data tool (admin sessions on the
// self-edit app only). Called through the module object so tests can
// stub gather().
const statusSvc = require('../services/status');
// Called through the module object (issueAnnounce.announceIssueCreated)
// so tests can stub the panel-refresh broadcast, mirroring how the route
// suites stub worker.isInFlight / statusSvc.gather.
const issueAnnounce = require('../services/issue-announce');
// #1037: shared issue-report draft creation. Backs both the agent's
// usernode-report-platform-issue CLI (via routes/internal.js) and the
// Mayor's in-process draft_issue_report tool below.
const issueDraft = require('../services/issue-draft');
const {
  reviewedHeadForSession,
  visualHeadForSession,
  currentVotePredicateSql,
} = require('../services/pr-vote-revision');
const notifications = require('../services/notifications');
// runSyncMain + persistBehindMain now live in services/sync-main.js so
// the conflict-resolver can drive a sync turn without a route-requires-
// route cycle. Re-exported below for backwards compatibility. Route
// handlers call through the module object (syncMainSvc.*) so tests can
// monkey-patch individual functions, mirroring how worker.isInFlight
// is stubbed in the route suites.
const syncMainSvc = require('../services/sync-main');
const {
  runSyncMain, persistBehindMain,
  // #955: the post-sync review advance now covers every native proposal, not
  // just CLI handoffs. Both names are the same function; the historical one is
  // kept because callers and tests import it from here.
} = syncMainSvc;

// Track sessions with active Claude Code workers. The Set lives in a
// shared module so services/sync-main.js writes to the same instance
// the chat handler and server.js's drain logic read.
const {
  activeWorkers,
  beginSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
} = require('../services/active-workers');
const sessionState = require('../services/session-state');
const turnWatchdog = require('../services/turn-watchdog');
const recoveryRetry = require('../services/recovery-retry');
const turnLifecycle = require('../services/turn-lifecycle');
const turnEffects = require('../services/turn-effects');
const llmTelemetry = require('../services/llm-telemetry');
const TURN_WRAPUP_EFFECT_KEYS = Object.freeze({
  llm: 'turn_wrapup_llm',
  pills: 'turn_wrapup_pills',
  message: 'turn_wrapup_message',
  spend: 'turn_wrapup_spend',
});
const HEADLESS_WRAPUP_EFFECT_KEYS = Object.freeze({
  llm: 'headless_wrapup_llm',
  message: 'headless_wrapup_message',
  spend: 'headless_wrapup_spend',
});

// Who may read a session's checks, details and live status: its owner, an
// admin, anyone while its owner has shared it and it is still underway, and
// anyone once it is a proposal up for a vote (or merging/merged). `session`
// needs `user_id`, `status` and `shared_at`.
function canViewSession(session, user) {
  if (!session || !user) return false;
  return session.user_id === user.id || !!user.isAdmin
    || (!!session.shared_at && ['active', 'paused'].includes(session.status))
    || ['promoted', 'merging', 'merged'].includes(session.status);
}

// A session that will not change again, for the session list's `?recent=N`.
const FINISHED_SESSION_STATUSES = new Set(['merged', 'archived']);
// `?recent=N` as a count of finished rows to keep: 1..200, or null to list
// them all.
function recentFinishedLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

// Content-free caller context for services/llm.js. This object is consumed
// locally by the telemetry wrapper and is never spread into a provider
// request body.
function invocationTelemetry(pool, session, component, backend = 'mayor') {
  return {
    pool,
    appId: session && session.app_id,
    sessionId: session && session.id,
    backend,
    component,
  };
}

function recordLocalCodingInvocation(pool, {
  session, turnId, turn, outcome, component, attemptNumber, correlationId, startedAt,
}) {
  if (!turnId) return;
  if (!['completed', 'failed', 'stopped', 'aborted', 'abandoned'].includes(outcome)) return;
  // A queued/offered turn that was declined before acceptance never invoked
  // the local model. Likewise, a vanished/abandoned offer is not enough
  // evidence to claim a provider invocation; only run-terminal outcomes are.
  const acceptedAt = turn && turn.accepted_at ? new Date(turn.accepted_at) : null;
  if (!acceptedAt || !Number.isFinite(acceptedAt.getTime())) return;
  const finishedAt = turn && turn.finished_at ? new Date(turn.finished_at) : new Date();
  const createdAt = turn && turn.created_at ? new Date(turn.created_at) : null;
  const durationMs = acceptedAt && Number.isFinite(acceptedAt.getTime())
    && Number.isFinite(finishedAt.getTime())
    ? Math.max(0, finishedAt.getTime() - acceptedAt.getTime())
    : Math.max(0, Date.now() - startedAt.getTime());
  const normalizedOutcome = outcome === 'completed'
    ? 'success'
    : (outcome === 'stopped' || outcome === 'aborted') ? 'cancelled' : 'error';
  const requestCharacters = typeof turn.prompt === 'string' ? turn.prompt.length : null;
  const responseText = typeof turn.spec_md === 'string'
    ? turn.spec_md
    : (typeof turn.summary === 'string' ? turn.summary : null);
  void llmTelemetry.record(pool, {
    invocationKey: `local_agent:${turnId}`,
    timestamp: acceptedAt || startedAt,
    appId: session.app_id,
    sessionId: session.id,
    provider: 'local',
    backend: 'coding_agent',
    component,
    requestedModel: null,
    servedModel: null,
    billingPath: 'local_subscription',
    inputTokens: null,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    requestMode: 'agent_new',
    requestMessageCount: requestCharacters == null ? null : 1,
    requestUserMessageCount: requestCharacters == null ? null : 1,
    requestContentBlockCount: requestCharacters == null ? null : 1,
    requestTextCharacters: requestCharacters,
    requestUserTextCharacters: requestCharacters,
    requestPayloadCharacters: requestCharacters,
    responseContentBlockCount: responseText == null ? null : 1,
    responseTextBlockCount: responseText == null ? null : 1,
    responseTextCharacters: responseText == null ? null : responseText.length,
    agentReportedDurationMs: durationMs,
    queueDurationMs: createdAt && Number.isFinite(createdAt.getTime())
      ? Math.max(0, acceptedAt.getTime() - createdAt.getTime())
      : null,
    costUsd: null,
    costSource: 'unavailable',
    durationMs,
    outcome: normalizedOutcome,
    stopReason: outcome || null,
    errorClass: normalizedOutcome === 'cancelled'
      ? 'cancelled'
      : (outcome === 'abandoned' ? 'network'
        : (normalizedOutcome === 'error' ? 'worker' : null)),
    attemptNumber,
    correlationId,
  });
}
const estimateGuard = require('../services/estimate-guard');
// #892: what an unearned "nearly done" phrase is replaced with. Mirrors the
// user-facing wording of ccPhaseLabel() in public/js/cc-progress-summary.js
// but phrased as an ongoing activity, since it sits where the model's own
// phrase would have. Keyed by the head word of the `[phase]` marker.
const NEUTRAL_PHASE_TEXT = {
  claude: 'still working through the changes',
  codex: 'still working through the changes',
  sync: 'syncing with main',
  refresh: 'syncing the branch',
  'inloop-db': 'still working through the changes',
};
const { isCliCredentialManagementSession } = require('../services/cli-api-policy');
// #894: the deterministic pill sets a turn falls back to when the Mayor
// omits suggest_replies (or the turn ends on a path with no wrap-up).
// #1001 adds the shared pill-composition rules (interpolated into the
// Mayor prompt, the tool description and both model-backed fallbacks) and
// the all-boilerplate detector that triggers enforcement.
const {
  turnFallbackQuickReplies,
  fallbackKindForTurn,
  buildRecoveryQuickReplies,
  QUICK_REPLY_RULES_TEXT,
  isGenericPillSet,
} = require('../services/recovery-pills');
// The Mayor's tools, pill ladder, history replay and system prompt live in
// services/mayor/* (#2779) so a conversation that is not one change can
// run the same loop. Imported back here for the dev-chat route, headless
// runs and recovery, and re-exported below for existing callers.
const {
  DISPATCH_TOOL,
  DISPATCH_SCOUT_TOOL,
  LIST_GITHUB_ISSUES_TOOL,
  GET_GITHUB_ISSUE_TOOL,
  WEB_FETCH_TOOL,
  GET_PROD_STATUS_TOOL,
  DRAFT_ISSUE_REPORT_TOOL,
  SUGGEST_ANSWERS_TOOL,
  QA_MAX_QUESTIONS,
  QA_MAX_ANSWERS,
  QA_MAX_ANSWER_LEN,
  QA_MAX_QUESTION_LEN,
  sanitizeSuggestedAnswers,
  resolveSuggestedAnswers,
  SUGGEST_REPLIES_TOOL,
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  sanitizeQuickReplies,
  resolveQuickReplies,
  shouldFallbackQuickReplies,
} = require('../services/mayor/tools');
const {
  QR_ENFORCE,
  QR_ENFORCE_TIMEOUT_MS,
  QR_GENERATE_TIMEOUT_MS,
  qrWithTimeout,
  resolveTurnPills,
  quickReplyMeta,
} = require('../services/mayor/pills');
const {
  salvageAssistantText,
  shouldRepromptForDataSummary,
  buildDataSummaryReprompt,
  DATA_SUMMARY_FALLBACK_TEXT,
  needsEmptyReplyFallback,
} = require('../services/mayor/replies');
const {
  DATA_TOOL_NAMES,
  DRAFT_TOOL_NAME,
  IN_PROCESS_TOOL_NAMES,
  MAYOR_DATA_TOOLS_MAX_ITERS,
  resolveGithubIssuesToolResult,
  resolveGithubIssueToolResult,
  resolveWebFetchToolResult,
  PROD_STATUS_MAX_BYTES,
  resolveProdStatusToolResult,
  resolveDraftIssueToolResult,
  resolveDataToolResult,
  dataToolStatusLine,
  DATA_TOOL_THINKING_STATUS,
} = require('../services/mayor/data-tools');
const {
  CODING_AGENT_COMPLETED_MARKER,
  COMPLETION_MARKER_RE,
  stripFakeCompletionMarker,
  buildMayorMessages,
} = require('../services/mayor/messages');
const {
  getMayorSystemPrompt,
} = require('../services/mayor/prompt');
const { runMayorTurn } = require('../services/mayor/turn');
// #937: pure stop policy — the pre-dispatch gate predicate and the
// confirm-loop's retry/give-up decision. Kept out of here so both are
// unit-testable without docker (same pattern as services/turn-watchdog).
const stopPolicy = require('../services/stop-policy');
const { stopPendingFor } = stopPolicy;

// A live request can lose its database connection after the detached worker
// has already produced a result. In that case the durable active_turn is the
// authority: keep the session reserved and hand it to the same recovery path
// boot adoption uses. The scheduler itself is injected by server.js to avoid
// a routes -> server require cycle.
async function scheduleRetainedInteractiveTurn({
  pool,
  sessionId,
  scheduleInteractiveRecovery,
  assumeRetained = false,
}) {
  let retained = assumeRetained;
  if (!retained) {
    try {
      retained = !!await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch (err) {
      // A failed read cannot prove the owner disappeared. Schedule
      // conservatively; the retry re-reads the durable phase itself.
      retained = true;
      log.warn('sessions', 'Could not inspect interactive durable turn; scheduling recovery', {
        sessionId, err: err.message,
      });
    }
  }
  if (!retained) return false;
  if (typeof scheduleInteractiveRecovery !== 'function') {
    log.error('sessions', 'Interactive durable turn retained without a recovery scheduler', {
      sessionId,
    });
    return false;
  }
  try {
    return (await scheduleInteractiveRecovery(sessionId)) !== false;
  } catch (err) {
    log.error('sessions', 'Could not schedule retained interactive turn recovery', {
      sessionId, err: err.message,
    });
    return false;
  }
}

const CLI_CREDENTIAL_MANAGEMENT_ERROR = 'credential_management_not_available_via_cli';
const MANUAL_SESSION_TITLE_MAX = 256;

// #2779: classic dev sessions — a per-change chat created straight from the
// browser — are phased out. New work starts in an agent session, whose
// Mayor creates each change through POST /api/apps/:slug/sessions on a
// delegated grant; nothing else may create one any more (not a browser, a
// shell cached before the switch, a CLI token, nor Global Chat's loopback),
// and forking a chat into a new classic session is retired with them.
// Sessions that already exist keep working exactly as they did: only the
// creation routes read this.
const CLASSIC_SESSIONS_RETIRED = 'New work starts in an agent session now. '
  + 'Start one from Messages or New change.';

// #1038: identifies THIS platform process to the client's session-state
// store. Live busy state is in-process memory (see services/session-state),
// so a restart or a blue-green cutover invalidates every override a client
// is holding. Shipping the boot time on each reconcile lets the client
// notice the swap and clear its state instead of showing a phantom spinner
// for a turn that died with the old process.
const PROCESS_BOOT_ID = String(Date.now());

// #1378: per-session stop handles now live in a shared leaf service so the
// detached-turn recovery path in server.js can register one too. See
// services/stop-registry.js for the handle shape and for the production
// failure that moved it out of this module. It also owns the
// sessionState.setPhaseResolver wiring that used to sit here.
const stopRegistry = require('../services/stop-registry');

// Per-session in-flight guard for on-demand staging rebuilds (the
// ensure-staging route below). Repeated Preview clicks while a rebuild is
// already running must not kick off a second concurrent docker build +
// pg clone for the same session. Mirrors the stagingHealAttempts map the
// sweeper uses in server.js. Cleared when the rebuild settles.
const ensureStagingInFlight = new Set();

// #447: per-session in-flight guard for the manual "Re-run checks" route
// below. Coalesces repeat clicks so one stuck proposal can't kick off
// several concurrent staging rebuilds + capture runs. Cleared when the
// recheck settles. (captureForSession is _inFlight-guarded internally too;
// this just avoids a redundant rebuild on the rebuild path.)
const recheckInFlight = new Set();

// ── Staging mock data ──────────────────────────────────────────────────
//
// Read-only transcript for the fake 99xxxx shared-session ids the
// ?demo=1 branch of GET /shared-sessions injects (those rows exist only in
// that response, never in the DB, so a real transcript read would 404 and
// the demo card's "Read chat" button would dead-end). Same convention as
// stagingMockIssueComments in routes/issues.js: request-time only, never
// persisted, and a strict no-op outside staging — the caller gates on
// USERNODE_ENV === 'staging' && ?demo=1 before consulting this.
//
// Deliberately includes rows the sanitiser must strip (metadata.ccLog, a
// platformIssueDraft card, per-message cost) so a tester can confirm on
// staging that they do NOT render in the read-only view. Because the mock
// goes through sanitizeTranscript exactly like a real read, that check
// exercises the real allowlist rather than a hand-written "safe" payload.
function stagingMockOwnSession(userId, appSlug) {
  return {
    id: 990101, branch_name: 'mock/my-session', pr_number: null,
    user_id: userId,
    pr_url: null, pr_title: null,
    session_title: '[Mock] Your in-progress session',
    // Reverse "#N" issue chip demo on the own-session card: links
    // to mock issue 900002, which stagingMockIssues serves.
    status: 'active', linked_issues: [900002], shared_at: null,
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    last_activity_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    app_slug: appSlug, app_name: 'Homeroom', busy: false,
    // #1959: this one is WAITING ON ITS OWNER — a spec that ended
    // with open questions — so the Improve panel's "Ready for your
    // input" pill is reviewable in a preview, right under the busy
    // row's "Working"; every other idle mock row reads plain
    // "Ready". Hand-set, like `busy` on 990102: the mocks are
    // appended after the map that computes the real verdict.
    awaiting_input: true,
  };
}

function stagingMockSharedSessions() {
  return [
          {
            id: 990001, session_title: '[Mock] Busy shared session — spinner state',
            pr_title: null, branch_name: 'mock/shared-busy', status: 'active',
            // Reverse "#N" issue chip demo: links to mock issue 900001,
            // which stagingMockIssues serves, so the round trip works.
            linked_issues: [900001],
            staging_url: null, can_preview: false, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date().toISOString(),
            chat_count: 0, last_message_at: null, busy: true,
            // Visible but chat NOT published — no "Read chat" chip. Kept
            // false on two of the three rows so the demo board shows both
            // states side by side.
            transcript_shared: false, message_count: 0,
          },
          {
            id: 990002, session_title: '[Mock] Paused shared session with a preview',
            pr_title: null, pr_number: 990002,
            pr_url: 'https://github.com/Usernode-Labs/social-vibecoding/pull/990002',
            branch_name: 'mock/shared-preview', status: 'paused',
            linked_issues: [],
            staging_url: 'https://example.invalid', can_preview: true, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            chat_count: 3, last_message_at: new Date().toISOString(), busy: false,
            // The one demo row with a readable chat: its "Read chat" chip
            // opens the topic page and stagingMockTranscript serves the
            // matching id, so the round trip works in a demo preview.
            transcript_shared: true, message_count: 8,
          },
          // #689: preview asleep (staging GC'd the container) but the
          // branch has pushed changes — the pill still renders and routes
          // through ensure-staging. Clicking it in a demo 404s (fake id)
          // into the "could not be rebuilt" loader, same as 990002.
          //
          // Worth knowing: this row modelled a state a REAL share-only
          // session could not be in. `can_preview: true` with no
          // staging_url was reachable only for a session with a pull
          // request, because the derivation above was `pr_number IS NOT
          // NULL` — so the demo board showed a rebuild affordance that the
          // thing it demonstrates never got. The fixture was right and the
          // derivation was wrong; the derivation now also reads
          // checks_commit_sha, and this row is honest.
          {
            id: 990003, session_title: '[Mock] Shared session, preview asleep (rebuild on click)',
            pr_title: null, branch_name: 'mock/shared-preview-asleep', status: 'paused',
            linked_issues: [],
            staging_url: null, can_preview: true, user_id: 0, username: 'staging-demo-user',
            shared_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            chat_count: 1, last_message_at: new Date().toISOString(), busy: false,
            transcript_shared: false, message_count: 0,
          }
  ];
}

const STAGING_MOCK_TRANSCRIPT_IDS = new Set([990002]);

// (#1012) Read-only mock spec version for the group-chat spec panel. Same
// convention as stagingMockTranscript above: request-time only, never
// persisted, and a strict no-op outside staging — the caller gates on
// USERNODE_ENV === 'staging' && ?demo=1 AND on the real lookup finding
// nothing, so a genuine row always wins.
//
// Why it's needed: chat_session_specs is staging:private, so a
// prod-cloned staging DB has ZERO spec content while chat_messages (and
// therefore the cloned spec_share cards in group chat) IS copied. Without
// this, every "View full spec" in a staging preview renders the 404 error
// branch and the panel's real layout — including its copy button — can't
// be reviewed.
//
// The document deliberately conforms to the platform's two-half spec
// convention (both marker headings), so a reviewer also exercises the
// dev-chat viewer's tab split and can confirm that "Copy markdown" yields
// the WHOLE document rather than the open tab's half.
const STAGING_MOCK_SPEC_MD = [
  '# [Mock] Readable cards on narrow screens',
  '',
  'Staging demo spec — the cards get a two-row layout so the title stops being crushed.',
  '',
  '## User-facing changes',
  '',
  '- Each card shows its title on its own line.',
  '- The action buttons wrap underneath instead of squeezing the title.',
  '',
  '## Technical implementation',
  '',
  '- Split the card renderer into a title row and an actions row.',
  '- The actions row wraps at narrow widths; no change above 640px.',
  '',
].join('\n');

function stagingMockSpecVersion(version) {
  return {
    version,
    content: STAGING_MOCK_SPEC_MD,
    built_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    commit_sha: null,
    pr_number: 9301,
    shared_to_group_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  };
}

// Same #1012 convention, for the version-LIST endpoint (GET /spec): a
// prod-cloned staging DB has zero chat_session_specs rows, so a reviewer
// opening a session's spec panel would always hit the empty state. The
// mock list is what a NON-OWNER would see after the shared-visibility
// filter: two shared versions with a gap where an unshared v2 would sit,
// so the non-contiguous dropdown (the filter's visible effect) is
// exercised too. Request-time only, never persisted, and reached only
// when the real lookup found nothing.
function stagingMockSpecList() {
  const meta = (v) => ({
    version: v.version,
    built_at: v.built_at,
    commit_sha: v.commit_sha,
    pr_number: v.pr_number,
    shared_to_group_at: v.shared_to_group_at,
    char_count: v.content.length,
  });
  const latest = stagingMockSpecVersion(3);
  const older = stagingMockSpecVersion(1);
  return { spec: latest.content, versions: [meta(latest), meta(older)] };
}

// The single source of truth for "is this frozen spec version visible to
// a viewer who does not own the session?" — shared to the app's group
// chat, privately shared with this exact viewer (#86), or shared into a
// conversation the viewer is an active member of (excluding blocked
// direct pairs). Interpolated (never parameterised) into both spec read
// routes — GET /api/sessions/:id/spec and GET /api/sessions/:id/specs/
// :version — so the list gate and the content gate cannot drift apart.
// `specAlias` is the chat_session_specs alias in the caller's query and
// `viewerParam` the $n placeholder carrying req.user.id.
function specVersionSharedVisibilitySql(specAlias, viewerParam) {
  return `(${specAlias}.shared_to_group_at IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM chat_session_spec_user_shares us
                   WHERE us.session_id = ${specAlias}.session_id
                     AND us.version = ${specAlias}.version
                     AND us.recipient_id = ${viewerParam}
                ) OR EXISTS (
                  SELECT 1
                    FROM chat_session_spec_conversation_shares scs
                    JOIN conversations shared_conversation
                      ON shared_conversation.id = scs.conversation_id
                     AND shared_conversation.status = 'active'
                    JOIN conversation_members cm
                      ON cm.conversation_id = scs.conversation_id
                   WHERE scs.session_id = ${specAlias}.session_id
                     AND scs.version = ${specAlias}.version
                     AND cm.user_id = ${viewerParam}
                     AND cm.status = 'member'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM conversations direct_conversation
                         JOIN conversation_direct_pairs direct_pair
                           ON direct_pair.conversation_id = direct_conversation.id
                         JOIN user_blocks direct_block
                           ON (direct_block.blocker_id = direct_pair.user_low_id
                               AND direct_block.blocked_user_id = direct_pair.user_high_id)
                            OR (direct_block.blocker_id = direct_pair.user_high_id
                               AND direct_block.blocked_user_id = direct_pair.user_low_id)
                        WHERE direct_conversation.id = scs.conversation_id
                          AND direct_conversation.kind = 'direct'
                     )
                ))`;
}

function stagingMockTranscript(sessionId) {
  if (!STAGING_MOCK_TRANSCRIPT_IDS.has(sessionId)) return null;
  const t = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
  const raw = [
    {
      id: 1, role: 'user', model: null, created_at: t(90), cost_cents: 0,
      content: '[Mock] Can we make the board cards a bit easier to read on a phone?',
      metadata: { attachments: [{ id: 'a'.repeat(32), filename: 'phone-screenshot.png', kind: 'image', sizeBytes: 51234 }] },
    },
    {
      id: 2, role: 'assistant', model: 'claude-opus-5', created_at: t(89),
      token_count: 812, cost_cents: 3.4,
      content: "[Mock] Sure — the title gets crushed by the action buttons at narrow widths. I'll split the card into a title row and a wrapping actions row.",
      metadata: {},
    },
    {
      id: 3, role: 'system', model: null, created_at: t(88),
      content: 'Claude Code is running',
      metadata: { progressLog: ['Reading public/js/app-view.js', 'Editing the card renderer', 'Running the layout tests'] },
    },
    {
      id: 4, role: 'system', model: null, created_at: t(85),
      content: 'Claude Code log',
      // MUST NOT render: raw agent stderr.
      metadata: { ccLog: '[Mock] raw stderr that a reader must never see' },
    },
    {
      id: 5, role: 'system', model: null, created_at: t(84),
      content: 'Spec drafted',
      metadata: { specPreview: '# [Mock] Readable cards on narrow screens\n\n- Two-row card layout\n- Actions wrap instead of crushing the title\n', specVersion: 1, specLines: 4 },
    },
    {
      id: 6, role: 'system', model: null, created_at: t(80),
      content: 'Changes ready',
      metadata: { changesReady: true, ccOutput: '[Mock] Split the session card into a title row and an actions row that wraps.', ccOutcome: 'success', durationMs: 252000, prNumber: 9301 },
    },
    {
      id: 7, role: 'system', model: null, created_at: t(79),
      content: 'The AI suggests reporting this to the platform',
      // MUST NOT render: owner-only action card.
      metadata: { platformIssueDraft: { body: '[Mock] draft report a reader must never see', status: 'pending', msgId: 7 } },
    },
    {
      id: 8, role: 'user', model: null, created_at: t(70),
      content: '[Mock] Nice — can the buttons keep their order when they wrap?',
      metadata: { suggestions: ['[Mock] leaked suggestion chip'] },
    },
  ];
  return {
    session: {
      id: sessionId,
      session_title: '[Mock] Paused shared session with a preview',
      pr_title: null,
      branch_name: 'mock/shared-preview',
      status: 'paused',
      username: 'staging-demo-user',
      transcript_shared_at: t(30),
      message_count: raw.length,
      is_owner: false,
      // Retired with classic sessions (#2779); see the transcript read.
      can_fork: false,
    },
    messages: transcriptShare.sanitizeTranscript(raw),
    truncated: false,
  };
}

// getActiveWorkerCount is imported from services/active-workers and
// re-exported at the bottom of this module (server.js imports it here).

// Daily LLM-spend caps used to live as hardcoded constants here. They
// now live in the platform_settings table (admin-tunable) and are read
// via src/services/limits.js with a 10s in-process cache. Per-user
// overrides come from users.daily_limit_cents.

// Pull the first ATX-style H1 from a spec's markdown content. Used by
// the spec-share endpoint so the group-chat card can show "Title"
// instead of just "spec v3". Returns null if no H1 is found in the
// first ~30 lines (good enough for AI-generated specs, which always
// start with a heading near the top). Capped at 120 chars so a
// pathologically long heading can't blow up card layouts.
function extractSpecTitle(content) {
  if (!content) return null;
  const lines = content.split('\n');
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      const t = line.slice(2).trim();
      if (t) return t.slice(0, 120);
    }
  }
  return null;
}

// Card snippet (body preview), with the title line stripped so the
// title doesn't render twice (once as the card heading, once at the
// top of the rendered-markdown snippet). 280 chars is enough for ~4
// lines of preview after the markdown renderer is done with it.
function extractSpecSnippet(content, title) {
  if (!content) return '';
  if (!title) return content.slice(0, 280);
  const lines = content.split('\n');
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].trim().startsWith('# ') && !lines[i].trim().startsWith('## ')) {
      start = i + 1;
    }
    break;
  }
  while (start < lines.length && lines[start].trim() === '') start++;
  return lines.slice(start).join('\n').slice(0, 280);
}

// runSyncMain + persistBehindMain moved to services/sync-main.js (see
// the require at the top of this file). They're re-exported below so
// any external importer keeps working.

// #138: every interactive turn completion now creates + pushes a
// session_done notification UNCONDITIONALLY (the persistent green bell
// item the user can return to any time), not just when notify_on_done was
// armed. createSessionDoneNotification's own unread-dedup (at most one
// unread session_done per (user, session) via INSERT … WHERE NOT EXISTS)
// collapses a back-and-forth conversation into a single pending item, so
// this doesn't spam. We still clear notify_on_done for tidiness, but it no
// longer gates creation. Called fire-and-forget from the chat handler's
// done hook — never throws into the SSE path.
async function notifySessionDone(pool, sessionId) {
  return notifySessionTurnEnd(pool, sessionId, 'session_done');
}

// #3181: the turn ended WITHOUT finishing — an error, a timeout, a lost
// worker — so the bell says "stopped before finishing" instead of "finished".
// Same arming, dedup and push as session_done; only the kind differs. The
// chat handler's done hook picks this one when the turn persisted a failure
// row (turnError) and nobody pressed stop; the restart recovery, the
// stale-turn watchdog and a system pause call it directly.
async function notifySessionStalled(pool, sessionId) {
  return notifySessionTurnEnd(pool, sessionId, 'session_stalled');
}

async function notifySessionTurnEnd(pool, sessionId, kind) {
  try {
    const { rows } = await pool.query(
      `UPDATE chat_sessions SET notify_on_done = FALSE
       WHERE id = $1
       RETURNING user_id, app_id`,
      [sessionId]
    );
    if (!rows.length) return;
    const create = kind === 'session_stalled'
      ? notifications.createSessionStalledNotification
      : notifications.createSessionDoneNotification;
    const created = await create(pool, {
      userId: rows[0].user_id, appId: rows[0].app_id, sessionId,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
  } catch (err) {
    log.warn('sessions', `${kind} notify failed`, { sessionId, err: err.message });
  }
}

// #161: headless auto-solve completion notification. Always fired at
// the runner's terminal writes (ready/failed) — starting an auto-solve
// opts the clicking user into the completion notification, no arming.
// Best-effort: a failed insert/push must never fail the run itself.
async function notifyAutoSolveDone(pool, { userId, appId, sessionId, detail }) {
  try {
    const created = await notifications.createAutoSolveDoneNotification(pool, {
      userId, appId, sessionId, detail,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
  } catch (err) {
    log.warn('sessions', 'auto_solve_done notify failed', { sessionId, err: err.message });
  }
}

async function loadSessionSpec(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT spec_md FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  return (rows[0] && rows[0].spec_md) || '';
}

// ── Failing proposal checks → next-turn context ──────────────────────────
//
// The coding agent never sees its own proposal-check verdicts: checks run
// in the capture container AFTER the turn ends, against staging, and no
// signal flows back into the session. Production proposal 3284 showed the
// result — a PR added a born-failing check, four more checks were failing
// for unrelated reasons, and the agent (whose `npm test` run was green)
// finished the turn believing everything passed.
//
// These two pieces close the loop from the platform side: when the
// session's LAST staging run left checks failing, the next build turn's
// prompt carries the failing rows (name, route, failure reason, first
// console error) with instructions to treat them as part of the task.
// Pure block builder + tiny loader, same shape as the spec block above.
// Advisory only — every caller fails open, an empty block costs nothing.
const FAILING_CHECKS_MAX = 12;

async function loadSessionCheckContext(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT check_state, test_results FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  if (!rows[0]) return { checkState: '', testResults: [] };
  let results = rows[0].test_results;
  if (typeof results === 'string') {
    try { results = JSON.parse(results); } catch { results = []; }
  }
  return {
    checkState: rows[0].check_state || '',
    testResults: Array.isArray(results) ? results : [],
  };
}

// The failing checks as DATA rather than prose, capped the same way.
//
// #1766: the coding agent has been told exactly which checks fail, with
// names, paths and reasons, since buildFailingChecksBlock below started
// injecting them into its prompt. The person watching the card got a number.
// So the board renders these same rows now, and both callers derive from one
// function — an agent and a human reading different answers about the same
// run is the failure this shape prevents.
//
// Both caps bend for the repo unit suite's row. It is ONE row standing for
// every failing unit test, and its reason is the only place the fix turn
// learns which test files to run. The row is appended after the browser
// checks, so behind twelve failing ones the row cap dropped it, and 300
// characters of its reason held a few test names and no file — a fix turn
// then re-ran the whole suite to find the rest. So it leads, where the row
// cap cannot reach it, and keeps the whole reason unit-suite.js already
// bounded.
function summarizeFailingChecks(checkState, testResults, max = FAILING_CHECKS_MAX) {
  if (checkState !== 'failing') return { total: 0, blocking: 0, rows: [] };
  const all = (Array.isArray(testResults) ? testResults : [])
    .filter((r) => r && r.status !== 'pass');
  const failing = [
    ...all.filter(unitSuiteRow.isUnitSuiteRow),
    ...all.filter((r) => !unitSuiteRow.isUnitSuiteRow(r)),
  ];
  return {
    total: failing.length,
    // Advisory rows report but do not block, so a reviewer counting them as
    // reasons the merge is held up would be reading a blocker that is not
    // one. Same distinction MergeStatus.lifecycle already draws for the pill.
    blocking: failing.filter((r) => !r.advisory).length,
    rows: failing.slice(0, max).map((r) => ({
      name: String(r.name || 'unnamed check').slice(0, 160),
      path: String(r.path || '').slice(0, 160) || null,
      reason: String(r.failureReason || 'failed')
        .slice(0, unitSuiteRow.isUnitSuiteRow(r) ? unitSuiteRow.FAILURE_DETAIL_MAX : 300),
      advisory: !!r.advisory,
      consoleError: Array.isArray(r.consoleErrors) && r.consoleErrors[0]
        ? String(r.consoleErrors[0].message || '').slice(0, 200)
        : null,
    })),
  };
}

function buildFailingChecksBlock(checkState, testResults) {
  const summary = summarizeFailingChecks(checkState, testResults);
  const failing = { length: summary.total };
  if (!summary.total) return '';

  const blocking = { length: summary.blocking };
  const lines = summary.rows.map((r) => {
    const firstConsole = r.consoleError ? ` · first console error: ${r.consoleError}` : '';
    return `- [${r.advisory ? 'advisory' : 'BLOCKING'}] "${r.name}"${r.path ? ` (path: ${r.path})` : ''} — ${r.reason}${firstConsole}`;
  });
  const more = failing.length > FAILING_CHECKS_MAX
    ? `\n(+${failing.length - FAILING_CHECKS_MAX} more failing)` : '';
  // The unit suite's reason is a per-file list, and the point of it is that
  // the agent re-runs those files instead of the whole suite (minutes).
  const unitRow = summary.rows.some((r) => unitSuiteRow.isUnitSuiteRow({ name: r.name, path: r.path }));
  const unitNote = unitRow ? `

The "${unitSuiteRow.UNIT_CHECK_NAME}" row is the repo's own \`npm test\`.
Its reason names every failing test FILE with how many of its tests failed,
then as many of their names as fit. Re-run just those files, with the runner
and flags the repo's \`test\` script uses, rather than the whole suite.` : '';

  return `

==== PROPOSAL CHECKS — CURRENTLY FAILING ====

After the previous commit, the platform ran this proposal's declared
checks (dapp.json \`tests\`) against its staging build. ${failing.length} of them are
FAILING${blocking.length ? ` and ${blocking.length} of those are MERGE-BLOCKING` : ' (all advisory for now)'}:

${lines.join('\n')}${more}

A proposal with failing merge-blocking checks CANNOT MERGE. Advisory
failures don't block yet, but a failing check that THIS session added
means the feature it covers does not actually render on staging —
usually missing staging seed data, a wrong selector, or a JS error.

Treat fixing these as part of this turn's task unless the user's request
explicitly says otherwise. Reproduce them locally first: boot the app
(see the in-loop browser instructions) and run \`usernode-run-checks\`
against the exact \`path:\` routes above, then fix the app (or the check,
if the check itself is wrong) and commit the fix with your other work.${unitNote}

==== END PROPOSAL CHECKS ====`;
}

// Build the inline spec-preview snippet (F8): cap length but cut on a
// whitespace boundary so we don't slice through a word or an inline
// markdown construct, then append an ellipsis.
function buildSpecPreview(content, max = 400) {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const bound = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (bound > max * 0.8) cut = cut.slice(0, bound);
  return `${cut}…`;
}

// #199: render the OPEN PROPOSALS block injected into the Mayor's system
// prompt on the FIRST turn of a fresh session, so the Mayor can spot when
// the user's request duplicates an existing promoted/merging proposal and
// suggest voting on that instead of starting redundant work. Pure function
// over rows from the candidate query in the chat handler; returns '' when
// there is nothing to show. Advisory only — every caller fails open.
const OPEN_PROPOSALS_MAX = 10;

function buildOpenProposalsBlock(proposals, currentUsername) {
  const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!list.length) return '';

  const entries = list.slice(0, OPEN_PROPOSALS_MAX).map((p) => {
    const title = (p.pr_title || '').trim();
    const prRef = p.pr_number
      ? `PR #${p.pr_number}${title ? ` — "${title}"` : ''}`
      : `${title ? `"${title}"` : 'Untitled proposal'} (no PR yet)`;
    const author = p.username
      ? `${p.username}${currentUsername && p.username === currentUsername ? " (this user's own proposal)" : ''}`
      : 'unknown';
    const lines = [
      `- ${prRef}`,
      `  Author: ${author} · Status: ${p.status || 'promoted'}${p.pr_url ? ` · ${p.pr_url}` : ''}`,
    ];
    const issues = Array.isArray(p.linked_issues) ? p.linked_issues.filter((n) => Number.isInteger(n)) : [];
    if (issues.length) lines.push(`  Issues: ${issues.map((n) => `#${n}`).join(', ')}`);
    const spec = buildSpecPreview((p.spec_md || '').trim(), 500);
    if (spec) lines.push(`  Spec excerpt: ${spec.replace(/\s+/g, ' ')}`);
    return lines.join('\n');
  });

  return `

==== OPEN PROPOSALS IN THIS APP ====

This is the user's FIRST message in a new session. The app already has the following open proposals (promoted/merging PRs the group is voting on):

${entries.join('\n')}

Before dispatching ANY tool, check whether the user's request SUBSTANTIALLY duplicates one of these proposals — i.e. the existing proposal would deliver the same feature or fix. Touching the same area with a different goal is NOT a duplicate; when unsure, do not raise it.

- If it duplicates one: do NOT dispatch any tool. Instead ask, in 1-2 sentences, naming the PR number and title explicitly so the reference survives into later turns, e.g. "There's already an open proposal — PR #N 'title' by author — that looks like it covers this. Want to vote on that in the group chat instead?" Include the PR link when there is one. If the matching proposal is the user's own, suggest returning to that session instead of voting. This follows the same rule as the clarity gate: never ask and dispatch in the same turn.
- If the user then confirms they want the existing one: point them to the group-chat vote panel; do not dispatch anything.
- If the user says theirs is different or additive: proceed as normal, AND ensure the differentiation is captured — when dispatching the scout, tell it to include a short "How this differs from PR #N" section in the spec; when dispatching the coding agent directly, restate the user's differentiation in your one-sentence preamble and include it in the dispatch prompt.

==== END OPEN PROPOSALS ====`;
}

// #945: the discussion context for ONE session — the Discussion thread on
// the issue this session works on, plus the Discussion thread on the
// session's own proposal. Rendered by services/thread-context and
// injected into the Mayor's system prompt and into scout/build dispatch
// prompts.
//
// Which issue: `created_from_issue_number` (set when the session was
// started from the issue panel) wins; otherwise the first entry of the
// Mayor-declared `linked_issues`. Both ride along on `SELECT cs.*`.
//
// Deliberately Homeroom-thread ONLY — no GitHub comment fetch here.
// github.fetchIssueComments is uncached and pages the anonymous API (60
// req/hr), so refetching it on every Mayor turn would add latency and
// burn the shared rate limit. The GitHub half of the discussion reaches
// the Mayor through the get_github_issue data tool (which returns both
// halves) and reaches an unattended run through the headless seed, where
// the comments are already fetched once per run.
//
// Never throws: every loader inside degrades to an empty result, so the
// worst case is no block.
async function buildSessionDiscussionBlock(pool, session) {
  if (!session) return '';
  try {
    const linked = Array.isArray(session.linked_issues) ? session.linked_issues : [];
    const issueNumber = Number.isInteger(session.created_from_issue_number)
      ? session.created_from_issue_number
      : linked.find((n) => Number.isInteger(n) && n > 0) || null;

    const [issueThread, proposalThread] = await Promise.all([
      issueNumber
        ? threadContext.loadIssueThread(pool, session.app_id, issueNumber)
        : Promise.resolve({ messages: [], truncated: false }),
      threadContext.loadProposalThread(pool, session.app_id, session.id),
    ]);

    return threadContext.buildDiscussionPromptBlock({
      issueBlock: threadContext.buildIssueDiscussionBlock({
        issueNumber,
        threadMessages: issueThread.messages,
        truncated: issueThread.truncated,
      }),
      proposalBlock: threadContext.buildProposalDiscussionBlock({
        sessionId: session.id,
        prNumber: session.pr_number || null,
        threadMessages: proposalThread.messages,
        truncated: proposalThread.truncated,
      }),
    });
  } catch (err) {
    log.warn('sessions', 'Discussion-context build failed (continuing without block)', {
      sessionId: session.id, err: err.message,
    });
    return '';
  }
}

// Unwrap a whole-document ```markdown fence a scout/spec-author LLM sometimes
// emits around the entire spec (see src/services/spec-format.js for the why
// and the conservative rules). Re-exported below so existing importers and
// tests can keep requiring it from this module.
const { stripSpecWrapperFence } = require('../services/spec-format');

// #1204: spot an agent run that died on the wire and reported it as its
// FINAL message ("API Error: Connection lost mid-response…") instead of in
// its exit code. A scout's final message IS the spec, so without this the
// notice is what gets stored as the session's spec doc. See
// src/services/agent-result-text.js.
const { agentApiFailure, describeAgentApiFailure } = require('../services/agent-result-text');

// #27: freeze the current spec content as a new immutable version in
// chat_session_specs and return its version number. Every spec mutation
// (scout) calls this and tags its inline spec
// preview card with the returned version, so clicking an OLDER card
// opens exactly the content it represented — instead of always falling
// back to the latest spec. Since #69 retired the manual "Save version"
// route, this and the native CLI proposal-handoff route are the only writers
// of new rows in chat_session_specs;
// it uses MAX(version)+1. Ordinary callers remain best-effort; durable scout
// publication passes required:true so the version and its receipt/card roll
// back together instead of committing a partially replayable outcome.
async function snapshotSessionSpec(pool, sessionId, content, { required = false } = {}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM chat_session_specs WHERE session_id = $1), 0) + 1, $2)
       RETURNING version`,
      [sessionId, content]
    );
    return rows[0].version;
  } catch (err) {
    log.warn('sessions', 'Failed to snapshot spec version', { err: err.message, sessionId });
    if (required) throw err;
    return null;
  }
}

// Publish a completed scout's three database effects as one receipt-backed
// transaction: latest spec, immutable version, and the transcript card. A
// crash after commit can then replay the receipt without creating another
// version or row. Legacy records without a stable turn id retain their
// historical best-effort path.
async function persistScoutPublication({
  pool,
  sessionId,
  turnId = null,
  content,
  conversationContent = null,
  hadSpec = false,
  durationMs = null,
  quickReplies = null,
  recovered = false,
  localAgentLabel = null,
  localMode = 'scout',
  agentBackend = null,
  agentModel = null,
}) {
  const ccText = String(content || '').trim();
  if (!ccText) throw new Error('persistScoutPublication: spec content required');
  const lineCount = ccText.split('\n').length;
  const baseScoutText = hadSpec
    ? `Scout revised the spec (now ${lineCount} lines).`
    : `Scout drafted a ${lineCount}-line spec from the codebase.`;
  const scoutText = localAgentLabel
    ? `${baseScoutText} Drafted on ${localAgentLabel}, so no Homeroom credits were used.`
    : baseScoutText;
  const persist = async (client, { requiredSnapshot }) => {
    await client.query(
      'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
      [ccText, sessionId],
    );
    const specVersion = await snapshotSessionSpec(
      client,
      sessionId,
      ccText,
      { required: requiredSnapshot },
    );
    const metadata = {
      specPreview: buildSpecPreview(ccText),
      specLines: lineCount,
      scoutOutput: ccText,
      ...(typeof conversationContent === 'string'
          && conversationContent.trim() === ccText
        ? { scoutConversationSpecExact: true }
        : {}),
      specVersion,
      ...(durationMs != null ? { durationMs } : {}),
      ...(quickReplies ? { quickReplies } : {}),
      ...(recovered ? { recovered: true } : {}),
      ...(agentBackend ? { agentBackend, agentModel: agentModel || null } : {}),
      ...(localAgentLabel
        ? { runner: 'local', localAgentLabel, localMode }
        : {}),
    };
    await client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, scoutText, JSON.stringify(metadata)],
    );
    return { scoutText, metadata, lineCount, specVersion, hadSpec: !!hadSpec };
  };

  if (turnId) {
    const receipt = await turnEffects.runDbEffect({
      pool,
      turnId,
      effectKey: turnEffects.EFFECT_KEYS.SCOUT_SPEC_PUBLICATION,
      sessionId,
      run: (client) => persist(client, { requiredSnapshot: true }),
    });
    return { applied: receipt.applied, ...(receipt.value || {}) };
  }

  const value = await persist(pool, { requiredSnapshot: false });
  return { applied: true, ...value };
}

// How much of a coding turn's summary is handed back to the Mayor as
// tool_result content. This is a PROMPT bound — an unbounded agent summary
// crowds out the Mayor's own context — and #2641 is the record of it being
// applied where it did not belong: a direct chat turn's summary is the
// agent's answer to the person, not a tool result, and cutting it at this
// length truncated long replies mid-sentence.
const MAYOR_TOOL_RESULT_CHAR_MAX = 4000;

const AGENT_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

class AgentSelectionError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.name = 'AgentSelectionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function agentSelectionErrorBody(err) {
  return {
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
  };
}

function automaticOpenRouterSetupError(err) {
  if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
    // QA 2026-09-24: no environment variable in the toast. The caller has
    // already logged err.message, which names USERNODE_OPENROUTER_MANAGEMENT_API_KEY
    // for whoever reads the server log; the person who pressed "Start work"
    // is told what it means for them.
    const message = err.code === 'not_configured'
      ? managedOpenRouter.NOT_CONFIGURED_USER_MESSAGE
      : `OpenRouter could not be set up automatically. ${err.message}`;
    return new AgentSelectionError(err.statusCode, message, err.code);
  }
  return new AgentSelectionError(
    503,
    'OpenRouter could not be set up automatically. Try again; if this continues, ask an administrator to check managed key provisioning.',
    'provision_failed',
  );
}

async function ensureOpenRouterCredential(pool, userId, config) {
  const credentialStore = require('../services/credential-store');
  let meta;
  try {
    meta = await credentialStore.readMetadata({
      pool, userId, provider: 'openrouter', purpose: 'coding_agent',
    });
  } catch (err) {
    log.error('sessions', 'OpenRouter credential check failed', {
      userId, err: err.message,
    });
    throw new AgentSelectionError(
      503,
      'OpenRouter could not be set up because its credential state could not be checked. Try again; if this continues, contact an administrator.',
      'credential_check_failed',
    );
  }
  if (meta?.status === 'valid') return { meta, provisioned: null };

  try {
    const provisioned = await managedOpenRouter.provision({ pool, userId, config });
    log.info('sessions', 'Automatically provisioned managed OpenRouter credential', {
      userId,
      managedKeyId: provisioned.managed?.id || null,
      model: provisioned.defaultModel || null,
    });
    return {
      meta: { status: 'valid', revision: provisioned.revision },
      provisioned,
    };
  } catch (err) {
    // A second tab can finish provisioning after the metadata read but
    // before this caller acquires the per-user reservation lock. Treat the
    // now-valid credential as success; every other failure remains visible.
    if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
      try {
        const refreshed = await credentialStore.readMetadata({
          pool, userId, provider: 'openrouter', purpose: 'coding_agent',
        });
        if (refreshed?.status === 'valid') return { meta: refreshed, provisioned: null };
      } catch (readErr) {
        log.error('sessions', 'OpenRouter credential recheck failed after provisioning conflict', {
          userId, err: readErr.message,
        });
      }
    }
    log.error('sessions', 'Automatic managed OpenRouter provisioning failed', {
      userId,
      code: err?.code || 'provision_failed',
      err: err?.message || String(err),
    });
    throw automaticOpenRouterSetupError(err);
  }
}

// Copy the user's DEFAULT coding-agent backend + model + reasoning effort
// into every new session path. An explicit Claude default always wins. When
// OpenRouter is enabled for an eligible user, a missing credential is no
// longer interpreted as permission to switch providers: the first real
// build/session action provisions the included managed key, stores OpenRouter
// as the default, and uses the provisioned model. Feature-policy fallbacks
// (flag off / beta access revoked) stay lenient and named. Provisioning,
// credential, and model-catalog failures stop with an actionable error so a
// broken deployment cannot masquerade as a successful Claude fallback.
async function resolveDefaultAgentPreference(client, userId, config) {
  const { rows: prefRows } = await client.query(
    `SELECT backend, model_id, reasoning_effort
       FROM user_agent_preferences
      WHERE user_id = $1 AND is_default = TRUE`,
    [userId],
  );
  const pref = prefRows[0];
  if (pref && pref.backend !== 'codex_openrouter') {
    // An explicit Claude preference always wins.
    return {
      backend: 'claude_code',
      provider: 'anthropic',
      model: null,
      reasoningEffort: null,
    };
  }

  // Deployment-policy fallbacks are still intentional. Credential and
  // provider failures below are not: those must be surfaced to the caller.
  const claudeFallback = (reason) => ({
    backend: 'claude_code',
    provider: 'anthropic',
    model: null,
    reasoningEffort: null,
    ...(pref ? { fallbackReason: reason } : {}),
  });

  // #2568 retired the gradual-rollout allowlist. CODEX_OPENROUTER_ENABLED is
  // the one remaining deployment switch.
  if (!config || !config.codexOpenrouterEnabled) {
    log.warn('sessions', 'Codex default not applied: feature disabled', { userId });
    return claudeFallback('flag_off');
  }

  const { meta, provisioned } = await ensureOpenRouterCredential(client, userId, config);
  if (provisioned) {
    const modelId = provisioned.defaultModel || null;
    if (!modelId) {
      throw new AgentSelectionError(
        503,
        'OpenRouter was set up, but no default model is available. Ask an administrator to check OPENROUTER_DEFAULT_CODEX_MODEL and the OpenRouter model catalog.',
        'model_unavailable',
      );
    }
    return {
      backend: 'codex_openrouter',
      provider: 'openrouter',
      model: modelId,
      // Provisioning writes this same default atomically with the key.
      reasoningEffort: null,
    };
  }

  let modelId = pref?.model_id
    || (config && config.openrouterDefaultCodexModel)
    || null;

  // Accounts with a usable key but no preference predate the
  // OpenRouter-default migration. Resolve their first new session against
  // the live key-visible catalog so a configured future model can fall back
  // safely until OpenRouter publishes it.
  if (!pref) {
    const credentialStore = require('../services/credential-store');
    let apiKey;
    try {
      apiKey = await credentialStore.readSecret({
        pool: client, userId, provider: 'openrouter', purpose: 'coding_agent',
        dataKey: config.dataEncryptionKey,
        expectedRevision: meta.revision,
      });
    } catch (err) {
      log.error('sessions', 'OpenRouter credential decrypt failed', { userId, err: err.message });
      throw new AgentSelectionError(
        503,
        'OpenRouter is configured, but its credential could not be read. Ask an administrator to check credential encryption and managed key provisioning.',
        'credential_unavailable',
      );
    }
    if (!apiKey) {
      throw new AgentSelectionError(
        503,
        'OpenRouter is configured, but its credential is unavailable. Ask an administrator to check managed key provisioning.',
        'credential_unavailable',
      );
    }
    try {
      const agentModels = require('../services/agent-models');
      const catalog = await agentModels.listOpenRouterModels({
        pool: client, userId, credentialRevision: meta.revision,
        apiKey, config, forceRefresh: false,
      });
      modelId = catalog.recommendedModelId || modelId;
    } catch (err) {
      log.error('sessions', 'OpenRouter default model catalog failed', { userId, err: err.message });
      throw new AgentSelectionError(
        503,
        'OpenRouter is configured, but its model catalog could not be loaded. Try again; if this continues, contact an administrator.',
        'model_catalog_unavailable',
      );
    }
  }
  if (!modelId) {
    throw new AgentSelectionError(
      503,
      'No default OpenRouter model is available. Ask an administrator to check OPENROUTER_DEFAULT_CODEX_MODEL and the OpenRouter model catalog.',
      'model_unavailable',
    );
  }

  return {
    backend: 'codex_openrouter',
    provider: 'openrouter',
    model: modelId,
    reasoningEffort: pref?.reasoning_effort || null,
  };
}

// Resolve an EXPLICIT user choice for a session. Unlike
// resolveDefaultAgentPreference(), this never falls back to Claude: the
// caller has chosen a backend and must either get that exact backend or a
// useful error explaining why it cannot be used. In particular, Codex model
// ids are catalog-validated because they become executable Codex config.
async function resolveExplicitAgentPreference(client, userId, config, {
  backend, model, reasoningEffort,
} = {}) {
  let resolved;
  try {
    resolved = registry.resolveBackend(backend);
  } catch {
    throw new AgentSelectionError(400, 'Unknown backend');
  }

  const effort = reasoningEffort == null || reasoningEffort === ''
    ? null
    : reasoningEffort;
  if (effort != null && !AGENT_REASONING_EFFORTS.has(effort)) {
    throw new AgentSelectionError(400, 'Invalid reasoning effort');
  }

  if (resolved === 'claude_code') {
    return {
      backend: 'claude_code',
      provider: 'anthropic',
      model: null,
      reasoningEffort: null,
    };
  }

  if (!config || !config.codexOpenrouterEnabled) {
    throw new AgentSelectionError(403, 'OpenRouter is not available on this deployment.');
  }
  if (config.openrouterBetaUserIds?.length
      && !config.openrouterBetaUserIds.includes(String(userId))) {
    throw new AgentSelectionError(403, 'OpenRouter is not available for your account yet.');
  }

  if (typeof model !== 'string' || !model.trim()) {
    throw new AgentSelectionError(400, 'Choose an OpenRouter model.');
  }
  const modelId = model.trim();

  const credentialStore = require('../services/credential-store');
  const agentModels = require('../services/agent-models');
  // Choosing OpenRouter is itself an active build action. If this eligible
  // user has not configured a key yet, create the included managed key
  // instead of sending them through Settings or changing providers.
  const { meta } = await ensureOpenRouterCredential(client, userId, config);

  let apiKey;
  try {
    apiKey = await credentialStore.readSecret({
      pool: client, userId, provider: 'openrouter', purpose: 'coding_agent',
      dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
    });
  } catch (err) {
    log.error('sessions', 'Explicit OpenRouter credential decrypt failed', {
      userId, err: err.message,
    });
    throw new AgentSelectionError(
      503,
      'OpenRouter is configured, but its credential could not be read. Ask an administrator to check credential encryption and managed key provisioning.',
      'credential_unavailable',
    );
  }
  if (!apiKey) {
    throw new AgentSelectionError(
      503,
      'OpenRouter is configured, but its credential is unavailable. Ask an administrator to check managed key provisioning.',
      'credential_unavailable',
    );
  }

  let catalog;
  try {
    catalog = await agentModels.listOpenRouterModels({
      pool: client, userId, credentialRevision: meta.revision,
      apiKey, config, forceRefresh: false,
    });
  } catch (err) {
    log.warn('sessions', 'Explicit Codex model validation failed', {
      userId, model: modelId, err: err.message,
    });
    throw new AgentSelectionError(
      503,
      'Could not validate that OpenRouter model right now. Try again; if this continues, contact an administrator.',
      'model_catalog_unavailable',
    );
  }
  const selectedCatalogModel = Array.isArray(catalog?.models)
    ? catalog.models.find((candidate) => candidate.id === modelId)
    : null;
  if (!selectedCatalogModel) {
    throw new AgentSelectionError(400, 'That model is not in the OpenRouter catalog.');
  }

  return {
    backend: 'codex_openrouter',
    provider: 'openrouter',
    model: modelId,
    reasoningEffort: selectedCatalogModel.supportsReasoning === false ? null : effort,
  };
}

// The switch behind POST /api/sessions/:id/reset-agent-context (its phases
// 2-5), for any caller that has already resolved `pref`: the route, and an
// agent session's dispatch, which applies the conversation's model choice to
// its active change right before the next build (services/mayor/
// agent-dispatch.js). Under a row lock: refuses a closed or busy change,
// switches the backend, model and effort, drops both resume ids, records the
// reset in the change's transcript, then evicts the warm worker.
async function switchSessionAgent(pool, { sessionId, userId, pref }) {
  const resolved = pref.backend;
  const isCodex = resolved === 'codex_openrouter';
  // ── Phase 2: one checked-out client + explicit transaction ──
  // (plan 8.2). The row lock is held until COMMIT so a concurrently
  // starting turn serializes correctly instead of racing the in-memory
  // busy check.
  const client = await pool.connect();
  let updatedRow = null;
  let contextMessage = null;
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, user_id, status, active_turn,
              agent_backend, agent_model, agent_reasoning_effort,
              agent_config_version
         FROM chat_sessions
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [sessionId, userId],
    );
    const sess = rows[0];
    if (!sess) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, status: 404, error: 'Session not found' };
    }
    if (sess.status === 'archived' || sess.status === 'merged') {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, status: 409, error: 'Session is closed' };
    }
    // ── Phase 3: authoritative post-lock busy recheck ──
    // (plan 8.3). The pre-lock check above is only a fast path; the
    // post-lock check (activeWorkers / inFlight / persisted active_turn)
    // is the source of truth now that we hold the row lock.
    if (activeWorkers.has(sessionId) || worker.isInFlight(sessionId) || sess.active_turn) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, status: 409, error: 'Session is busy; stop the current turn first.' };
    }

    // ── Phase 4: conditional update ── (plan 8.4)
    // `WHERE ... AND active_turn IS NULL` guarantees exactly one row is
    // touched; RETURNING * lets us return the ACTUAL row we inserted.
    const upd = await client.query(
      `UPDATE chat_sessions SET
         agent_backend = $2,
         agent_provider = $3,
         agent_model = $4,
         agent_reasoning_effort = $5,
         agent_thread_id = NULL,
         cc_session_id = NULL,
         agent_config_version = agent_config_version + 1,
         agent_context_reset_at = NOW()
       WHERE id = $1 AND active_turn IS NULL
       RETURNING *`,
      [sessionId, pref.backend, pref.provider,
       pref.model, pref.reasoningEffort],
    );
    if (upd.rows.length !== 1) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, status: 409, error: 'Session is busy; stop the current turn first.' };
    }
    updatedRow = upd.rows[0];

    const agentLabel = isCodex
      ? `OpenRouter (${safeAgentModelLabel(pref.model)})`
      : 'Claude Code';
    const changedBackend = registry.resolveBackend(sess.agent_backend) !== pref.backend;
    const messageText = isCodex
      ? (changedBackend
        ? `Session AI switched to ${agentLabel}. Fresh model context will start on the next turn; the branch and conversation were kept.`
        : `${agentLabel} context was reset. Fresh model context will start on the next turn; the branch and conversation were kept.`)
      : (changedBackend
        ? `Coding agent switched to ${agentLabel}. A fresh agent context will start on the next turn; the branch and conversation were kept.`
        : `${agentLabel} context was reset. A fresh agent context will start on the next turn; the branch and conversation were kept.`);
    const msg = await client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3) RETURNING *`,
      [sessionId, messageText, JSON.stringify({
        type: 'agent_context_reset',
        previousBackend: sess.agent_backend,
        agentBackend: pref.backend,
        agentModel: pref.model,
        reasoningEffort: pref.reasoningEffort,
      })],
    );
    contextMessage = msg.rows[0] || null;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // ── Phase 5: commit before worker eviction ── (plan 8.6)
  // After Commit 1 the warm container no longer holds provider secrets,
  // so eviction is best-effort (a failure still leaves a consistent DB).
  if (typeof worker.evictWorker === 'function') {
    await worker.evictWorker(sessionId).catch((evErr) => {
      log.warn('sessions', 'reset-agent-context eviction warning', { sessionId, err: evErr.message });
    });
  }

  return { ok: true, session: updatedRow, message: contextMessage };
}

// Resume a paused session of the user's: the body of POST
// /api/sessions/:id/resume, shared with the chat route, which resumes a paused
// session by itself when the user messages it (#2779 follow-up: "paused" is
// bookkeeping the user never has to manage). Ownership is checked first, then
// the global cap (another user's idle session may be paused), then the user's
// own cap (their least recently used session is paused). Returns { ok: true }
// or { ok: false, status, error }.
async function resumePausedSession({ pool, config, user, sessionId }) {
  // Ownership FIRST: everything below is platform-wide bookkeeping (the
  // global-cap probe can pause a third party's idle session, the per-user
  // LRU one of the requester's own), and none of it may run for a request
  // that was going to 404 anyway.
  const { rows: ownRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, user.id]
  );
  if (!ownRows.length) return { ok: false, status: 404, error: 'Session not found or not paused' };

  const { rows: globalRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM chat_sessions
      WHERE status IN ('active', 'promoted')
        AND source IS DISTINCT FROM 'imported'
        AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)`
  );
  if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
    // At the global cap: reclaim a slot from a globally idle session
    // (not this one) rather than blocking the reopen. Only 429 if
    // everything else is genuinely active.
    const { freed } = await sessionLifecycle.freeGlobalSlot({
      pool, graceMs: config.sessionPressureGraceMs, excludeSessionId: sessionId,
    });
    if (!freed) {
      return { ok: false, status: 429, error: 'Platform is at capacity right now. Try again in a few minutes.' };
    }
  }

  // Per-user cap counts only 'active' sessions (#193) — promoted ones
  // are un-pausable while their PR is in a vote, so they're exempt.
  // This also keeps the count consistent with the LRU eviction below,
  // which has always only considered 'active' victims. The ceiling is
  // per-requester (full admins get a raised cap; see
  // services/session-caps.js) — raising it just means the LRU pause
  // below fires less often for them.
  const caps = effectiveSessionCaps(config, user);
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM chat_sessions
     WHERE user_id = $1 AND status = 'active'
       AND source IS DISTINCT FROM 'imported'`,
    [user.id]
  );
  if (parseInt(countRows[0].cnt) >= caps.activeSessions) {
    if (!config.sessionLruOnResume) {
      return { ok: false, status: 429, error: `You already have ${caps.activeSessions} sessions in progress. Try again when one of them finishes.` };
    }
    // LRU: pause the user's least-recently-active 'active' session
    // (not 'promoted' — those await merge votes) to free a slot.
    // Skip any that are mid-turn; if none can be freed, 429.
    const { freed } = await sessionLifecycle.freeUserSlot({
      pool, userId: user.id, excludeSessionId: sessionId, includeHeadless: true,
    });
    if (!freed) return { ok: false, status: 429, error: sessionLifecycle.USER_SLOTS_BUSY };
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'active', last_activity_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'paused'
     RETURNING id, app_id`,
    [sessionId, user.id]
  );
  if (!rows.length) return { ok: false, status: 404, error: 'Session not found or not paused' };

  const { rows: sessionRows } = await pool.query(
    `SELECT a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const appSlug = sessionRows[0]?.app_slug;

  const { pushSessionUpdate } = require('../services/ws');
  pushSessionUpdate({ action: 'resumed', sessionId, appSlug });
  log.info('sessions', 'Session resumed', { sessionId });

  // #8: if the resumed session is behind main, kick off a silent
  // sync in the background. The HTTP response returns immediately
  // (the UI doesn't wait for the sync to complete) — drift
  // accounting is best-effort and the dev-chat banner will
  // update via the session_update WS event when it lands. We
  // run this only when the session has a known positive drift
  // count from a prior turn; sessions that never ran a turn
  // have behind_main=0 and the next /chat turn will populate it.
  const { rows: driftRows } = await pool.query(
    'SELECT behind_main FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  if ((driftRows[0]?.behind_main || 0) > 0) {
    // Fire-and-forget. Failures are logged but don't bubble up;
    // the user explicitly clicking "Sync with main" later will
    // re-attempt with full surface area for errors.
    runSyncMain(config, pool, sessionId, { trigger: 'resume_autosync' }).catch((err) => {
      log.warn('sessions', 'Background sync-on-resume failed', {
        sessionId, err: err.message,
      });
    });
  }
  return { ok: true };
}

function sessionRoutes(config, { scheduleInteractiveRecovery = null } = {}) {
  const router = Router();
  const pool = getPool(config);

  // #1038: the notifier needs a pool to resolve a touched session's app /
  // owner / share state before it can decide who a `session_state` event
  // goes to. It has no config of its own, so hand it the one this router
  // already built.
  sessionState.setPool(pool);

  // Per-app visibility gate for every session-id-addressed route below
  // (/api/sessions/:id/...): resolves the session's app and requires
  // collab-level access. 404 on deny so private apps' sessions aren't
  // enumerable; missing sessions fall through to each route's own 404.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // PATCH /api/sessions/:id/linked-issues (#2028)
  //
  // A proposal's issue links used to be writable only as a side effect of
  // creating it or dispatching another coding turn. This is the direct seam
  // used by the React proposal detail and the hosted connector after the
  // proposal/PR already exists.
  //
  // Owner-scoped for automated callers, with the platform's full write admin
  // as the browser/API repair hatch. A connector token can belong to an
  // admin too, so `connectorClientId` keeps that stronger privilege out of
  // this narrowly delegated tool.
  // The app-level collab gate above runs first; the 404 below deliberately
  // hides whether a foreign proposal id exists. Deltas preserve links added
  // by another tab/agent after the caller last read the proposal, and removal
  // wins when a number is present in both arrays.
  router.patch('/api/sessions/:id/linked-issues', drainGuard, async (req, res) => {
    const sessionId = /^[1-9]\d{0,9}$/.test(String(req.params.id || ''))
      ? Number(req.params.id) : null;
    if (!sessionId || sessionId > 2147483647) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'invalid_request', message: 'Body must be an object.' });
    }
    const unsupported = Object.keys(body).filter((key) => !['addIssues', 'removeIssues'].includes(key));
    if (unsupported.length) {
      return res.status(400).json({
        error: 'invalid_request', message: `Unsupported field: ${unsupported[0]}.`,
      });
    }
    const parseNumbers = (value, label) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 50) {
        throw new Error(`${label} must be an array of at most 50 issue numbers.`);
      }
      const unique = [];
      for (const raw of value) {
        if (!Number.isSafeInteger(raw) || raw <= 0 || raw > 2147483647) {
          throw new Error(`${label} must contain positive integers up to 2147483647.`);
        }
        if (!unique.includes(raw)) unique.push(raw);
      }
      return unique;
    };

    let addIssues;
    let removeIssues;
    try {
      addIssues = parseNumbers(body.addIssues, 'addIssues');
      removeIssues = parseNumbers(body.removeIssues, 'removeIssues');
    } catch (err) {
      return res.status(400).json({ error: 'invalid_request', message: err.message });
    }
    if (!addIssues.length && !removeIssues.length) {
      return res.status(400).json({
        error: 'invalid_request', message: 'Add or remove at least one issue number.',
      });
    }

    try {
      // Serialize against submit_work's proposal update too: both can project
      // metadata into the same live PR body, and the later GitHub write must
      // never restore the earlier one's stale closing block.
      const outcome = await proposalUpdate.withProposalLock(pool, sessionId, async () => {
        const { rows } = await pool.query(
          `SELECT cs.*, a.slug AS app_slug, a.repo_url
             FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
            WHERE cs.id = $1`,
          [sessionId]
        );
        const session = rows[0] || null;
        const owner = session && Number(session.user_id) === Number(req.user.id);
        const browserAdmin = session && !req.connectorClientId && req.user.canAdminWrite;
        if (!session || (!owner && !browserAdmin)) {
          return { response: { status: 404, body: { error: 'Session not found' } } };
        }

        const nextLinks = prMetadata.applyIssueDeclarations(
          session.linked_issues, addIssues, removeIssues
        );
        if (nextLinks.length > 50) {
          return { response: { status: 400, body: {
            error: 'invalid_request', message: 'A proposal can link at most 50 issues.',
          } } };
        }
        const repo = github.parseGithubUrl(session.repo_url);
        const result = await proposalUpdate.updateLinkedIssues({
          pool,
          gh: github,
          session,
          owner: repo && repo.owner,
          repo: repo && repo.repo,
          addIssues,
          removeIssues,
        });
        return { session, result };
      });

      if (outcome.response) {
        return res.status(outcome.response.status).json(outcome.response.body);
      }
      const { session, result } = outcome;

      if (result.changed) {
        try {
          const { pushIssueUpdate } = require('../services/ws');
          pushIssueUpdate({
            action: 'updated', source: 'linked_issues', sessionId,
            appId: session.app_id, appSlug: session.app_slug,
          });
        } catch (err) {
          log.warn('sessions', 'linked-issues broadcast failed', {
            sessionId, err: err.message,
          });
        }
      }
      return res.json({
        ok: true,
        proposalId: sessionId,
        appSlug: session.app_slug,
        linkedIssues: result.linkedIssues,
        addedIssues: result.addedIssues,
        removedIssues: result.removedIssues,
        changed: result.changed,
        prBodyUpdated: result.prBodyUpdated,
        prBodyStatus: result.prBodyStatus,
      });
    } catch (err) {
      log.error('sessions', 'Failed to update linked issues', { sessionId, message: err.message });
      return res.status(500).json({ error: 'Could not update linked issues' });
    }
  });

  // PATCH /api/sessions/:id/title (#2327)
  //
  // Rename the author's own native change throughout its open lifecycle:
  // Underway (active/paused) and In review (promoted/merging). The
  // display title and proposed PR title move together: before a PR exists,
  // `proposed_pr_title` is what pr-metadata will use when it creates one;
  // after a managed PR exists, the local proposal title moves immediately
  // and GitHub is a best-effort mirror. Imported PR titles stay with their
  // external author, and headless issue runs are named by their issue.
  //
  // The app-level collab gate above runs first. The UPDATE repeats the
  // narrower author/lifecycle/source checks atomically and returns the same
  // 404 for every miss so a foreign private session cannot be enumerated.
  router.patch('/api/sessions/:id/title', drainGuard, async (req, res) => {
    const sessionId = /^[1-9]\d{0,9}$/.test(String(req.params.id || ''))
      ? Number(req.params.id) : null;
    if (!sessionId || sessionId > 2147483647) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rawTitle = req.body?.title;
    const title = typeof rawTitle === 'string'
      ? rawTitle.replace(/\s+/g, ' ').trim()
      : '';
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (title.length > MANUAL_SESSION_TITLE_MAX) {
      return res.status(400).json({
        error: `Title too long (max ${MANUAL_SESSION_TITLE_MAX} chars)`,
      });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs
            SET session_title = $1::text,
                proposed_pr_title = $1::text,
                pr_title = CASE WHEN cs.pr_number IS NULL THEN cs.pr_title ELSE $1::text END,
                pr_title_fallback = CASE
                  WHEN cs.pr_number IS NULL THEN cs.pr_title_fallback ELSE FALSE END
           FROM apps a
          WHERE cs.id = $2 AND cs.user_id = $3 AND a.id = cs.app_id
            AND cs.status IN ('active', 'paused', 'promoted', 'merging')
            AND cs.is_headless = FALSE
            AND cs.source IS DISTINCT FROM 'imported'
          RETURNING cs.id, cs.app_id, a.slug AS app_slug, a.repo_url,
                    cs.pr_number, cs.pr_title, cs.session_title,
                    cs.proposed_pr_title`,
        [title, sessionId, req.user.id]
      );
      const session = rows[0];
      if (!session) return res.status(404).json({ error: 'Session not found' });

      let githubUpdated = false;
      if (session.pr_number) {
        const fullRepo = proposalUpdate.repoNameFromUrl(session.repo_url);
        if (fullRepo) {
          const [owner, repo] = fullRepo.split('/');
          try {
            await github.updatePR(owner, repo, Number(session.pr_number), { title });
            githubUpdated = true;
          } catch (err) {
            // The panel already has the author's rename. GitHub is a
            // cosmetic mirror and a transient outage must not roll it back.
            log.warn('sessions', 'Proposal title saved but GitHub rename failed', {
              sessionId, prNumber: session.pr_number, message: err.message,
            });
          }
        }
      }

      try {
        const { pushSessionUpdate } = require('../services/ws');
        pushSessionUpdate({
          action: 'titled', sessionId, appId: session.app_id,
          appSlug: session.app_slug, sessionTitle: title,
        });
      } catch (err) {
        log.warn('sessions', 'Proposal title broadcast failed', {
          sessionId, message: err.message,
        });
      }

      return res.json({
        ok: true,
        proposalId: sessionId,
        title,
        prTitle: session.pr_number ? title : null,
        githubUpdated,
      });
    } catch (err) {
      log.error('sessions', 'Proposal title update failed', {
        sessionId, message: err.message,
      });
      return res.status(500).json({ error: 'Could not update the title' });
    }
  });

  // GET /api/me/active-sessions
  //   Cross-app view of the current user's non-archived sessions,
  //   each annotated with whether a CC turn is in flight right now.
  //   Used by the dev-chat tab's "Active Sessions (x/y)" panel so a
  //   user can see all their in-progress AI work at a glance — even
  //   from other projects — without flipping through apps.
  //
  //   "busy" comes from the same in-process state the per-session
  //   /status endpoint uses: activeWorkers (chat handler's in-flight
  //   window) OR worker.isInFlight (warm-registry exec flag). The
  //   container-status fallback is intentionally NOT used here, for
  //   the same warm-CC reason described in /api/sessions/:id/status.
  //
  //   The result includes paused sessions too — the panel's job is
  //   "see all your dev work across apps and resume any of it", and
  //   paused rows are exactly what makes that useful.
  //
  //   "totals" lets the caller render the (x/y) header without a
  //   second pass through the array:
  //     - active   = 'active'-status sessions only — the set counting
  //                  against the per-user slot cap (#193). Promoted
  //                  sessions no longer count (they're un-pausable while
  //                  their PR is up for vote).
  //     - promoted = 'promoted'-status sessions (PR in a merge vote;
  //                  violet in the UI, exempt from the per-user cap)
  //     - paused   = paused-status sessions (no warm worker)
  //     - busy     = subset of active+promoted where CC is mid-turn right now
  //     - total    = active + promoted + paused (every non-archived row
  //                  we returned)
  //
  //   "caps" carries the DENOMINATORS for that header — the viewer's own
  //   effective per-user ceilings ({ activeSessions, promotedSessions }),
  //   which are higher for full platform admins (services/session-caps.js).
  //   The client used to hardcode "/3", which silently lied the moment an
  //   operator retuned MAX_USER_SESSIONS; shipping the real numbers here
  //   keeps display and enforcement from drifting. Always present, incl.
  //   on the ?demo=1 path.
  router.get('/api/me/active-sessions', async (req, res) => {
    try {
      // Imported PRs have no dev-chat worker. Keep them out of callers that
      // use this endpoint as a cross-app worker/session list; the Dev board
      // opts in so it can render the owner's imported In-progress cards.
      const includeImported = req.query.include_imported === '1';
      // last_activity_at = the newest message in the session's thread,
      // falling back to the session's own creation time. The dev tab's
      // card list sorts session rows by this ("most recent activity"),
      // not by creation order.
      //
      // The app's artwork rides along for the Improve panel's leading tile.
      // NOT `a.icon_url` — no such column: the table stores `icon_image_id`
      // and the server builds the path, as routes/apps.js does. And the note
      // is here rather than a `--` comment in the query, which reaches
      // scripts/check-sql.js as one flattened line that eats the statement.
      //
      // `source` is carried so a caller can tell where a proposal's head lives
      // (#1054) — an imported pull request usually follows a branch in its
      // author's own fork, everything else a branch only the platform can
      // write — without a second read per row. `imported_pr_head_repo` and
      // `a.repo_url` are carried with it because "usually" is not good enough
      // (#1196): the connector's mirror rung imports a pull request whose head
      // is a branch in the APP repository, and only comparing the two repos
      // separates that from a genuine fork.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
                cs.session_title, cs.status, cs.linked_issues, cs.shared_at,
                cs.transcript_shared_at, cs.created_at, cs.source,
                cs.staging_url, cs.imported_pr_author, cs.imported_pr_head_repo,
                cs.imported_pr_head_sha, cs.reviewed_head_sha, a.repo_url,
                cs.check_state, cs.check_phase, cs.check_error_detail,
                cs.test_results, cs.spec_md,
                cs.agent_backend, cs.agent_model, cs.external_agent, cs.build_venue,
                -- #2779: a change started from an agent session is listed
                -- under that conversation in Messages, not as a row of its own.
                cs.agent_session_id,
                GREATEST(cs.created_at, COALESCE(m.last_message_at, cs.created_at)) AS last_activity_at,
                lt.role AS last_turn_role, lt.asks AS last_turn_asks,
                a.slug AS app_slug, a.name AS app_name,
                a.icon_emoji AS app_icon_emoji,
                CASE WHEN a.icon_image_id IS NOT NULL
                     THEN '/app-icons/' || a.icon_image_id END AS app_icon_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_message_at
           FROM chat_session_messages
           WHERE session_id = cs.id
         ) m ON TRUE
         LEFT JOIN LATERAL (
           SELECT role,
                  jsonb_array_length(COALESCE(metadata->'suggestions', '[]'::jsonb)) > 0 AS asks
           FROM chat_session_messages
           WHERE session_id = cs.id AND role IN ('user', 'assistant')
           ORDER BY id DESC
           LIMIT 1
         ) lt ON TRUE
         WHERE cs.user_id = $1 AND cs.status IN ('active', 'promoted', 'paused')
           AND cs.is_headless = FALSE
           AND ($2::boolean OR cs.source IS DISTINCT FROM 'imported')
         ORDER BY last_activity_at DESC`,
        [req.user.id, includeImported]
      );
      // #1196: the same login /api/sessions/:id carries, read once for the
      // whole list rather than per row. It is what makes "can you push this
      // proposal's head" the answer the update path will actually give.
      const viewerLogin = rows.some((s) => s.source === 'imported')
        ? (await require('../services/github-link').linkStatus(pool, req.user.id)).login || null
        : null;
      let sessions = rows.map((s) => {
        const live = workerProgress.get(s.id);
        // #1959: the three columns selected for sessionAwaitsInput stop here.
        // The verdict is one boolean; the spec body is the thing the per-app
        // list refuses to put in a list payload (#894), and the last-turn
        // pair is meaningless without the rule that reads it.
        const {
          spec_md: specMd, last_turn_role: lastTurnRole, last_turn_asks: lastTurnAsks, ...row
        } = s;
        return {
          ...row,
          ...(s.source === 'imported' ? { viewer_github_login: viewerLogin } : {}),
          busy: isSessionBusy(s.id),
          awaiting_input: sessionAwaitsInput({
            lastTurnRole, lastTurnAsks, prNumber: s.pr_number, specMd,
          }),
          // Keep the pinned snake_case fields untouched. Camel-case fields
          // describe the runtime actually producing progress right now, so a
          // Codex-pinned session delegated to local Claude has an honest busy
          // tooltip without changing what its next platform turn will use.
          ...(live?.backend
            ? { agentBackend: live.backend, agentModel: live.model || null }
            : {}),
        };
      });
      sessions = await enrichImportedUnderwaySessions(pool, sessions, req.user.id);
      const totals = sessions.reduce(
        (acc, s) => {
          if (s.status === 'paused') acc.paused += 1;
          else if (s.status === 'promoted') acc.promoted += 1;
          else acc.active += 1;
          if (s.busy) acc.busy += 1;
          return acc;
        },
        { active: 0, promoted: 0, paused: 0, busy: 0 }
      );
      totals.total = sessions.length;
      // Staging-only demo row (?demo=1): a mock own session so the Dev
      // board's pinned block (caption + "Make visible" button) renders
      // for ANY viewer in a demo preview — the real seeded sessions
      // belong to the first admin only. Appended AFTER totals so the
      // "(x/y)" headers stay honest; fake 99xxxx id whose writes still 404
      // server-side. Its read-only detail projection exists so declared
      // checks can open the full change page without a console-erroring 404.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(
          stagingMockOwnSession(req.user.id, config.selfAppSlug),
          // Card-as-pointer revision: a PRIVATE session that already has a
          // PR, so the muted/draft shell renders WITH the icon Preview
          // affordance beside its ⋯. Both other private rows have
          // pr_number: null, so without this one the muted-plus-preview
          // combination is unreviewable in a preview.
          {
            id: 990107, branch_name: 'mock/my-session-private-pr', pr_number: 990107,
            pr_url: null, pr_title: null,
            session_title: '[Mock] Your private session with a preview',
            status: 'active', linked_issues: [900011], shared_at: null,
            created_at: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          },
          // Busy own session — exercises the "working…" state (spinner tag
          // beside the title, which the single-row shell keeps uncrushed).
          {
            id: 990102, branch_name: 'mock/my-session-busy', pr_number: null,
            pr_url: null, pr_title: null,
            session_title: '[Mock] Busy own session with a fairly long title to verify the working-state layout',
            status: 'active', linked_issues: [], shared_at: null,
            created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
            last_activity_at: new Date().toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: true,
          },
          // Visible (shared) own session — renders below the archived
          // toggle under the "Visible to everyone." caption, with the
          // Preview (#689: pr_number set) + Open chat + Share chat + Hide
          // buttons. transcript_shared_at is NULL here, so this row is the
          // "visible, chat still private" half of the chip pair.
          {
            id: 990103, branch_name: 'mock/my-session-visible', pr_number: 990103,
            pr_url: 'https://github.com/Usernode-Labs/social-vibecoding/pull/990103', pr_title: null,
            session_title: '[Mock] Your visible session',
            status: 'active', linked_issues: [],
            shared_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            transcript_shared_at: null,
            created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          },
          // The other half: visible AND transcript-published, so the card
          // renders the "Chat shared" toggle plus the "· chat readable"
          // subtitle. A live seed can't hold both states at once (one row,
          // one flag), which is exactly what the demo path is for.
          {
            id: 990104, branch_name: 'mock/my-session-chat-shared', pr_number: 990104,
            pr_url: null, pr_title: null,
            session_title: '[Mock] Your visible session with the chat shared',
            status: 'active', linked_issues: [],
            shared_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
            transcript_shared_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            created_at: new Date(Date.now() - 70 * 60 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          },
          // #747: promoted own session whose id matches the first mock
          // proposal (stagingMockProposals in votes.js), which the
          // /api/me/proposals demo block also returns — so the work
          // drawer's de-dup is reviewable via ?demo=1: this row must
          // render under "Your proposals" only, never "Your sessions".
          {
            id: 9000001, branch_name: 'mock/my-promoted-session', pr_number: 900101,
            pr_url: null,
            pr_title: '[Mock] Promoted session — must NOT appear under Your sessions',
            session_title: '[Mock] Promoted session — must NOT appear under Your sessions',
            status: 'promoted', linked_issues: [], shared_at: null,
            created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          },
          // A proposal-in-vote row so the dev drawer's violet "Proposed"
          // card state is reviewable in a demo preview. Unlike 9000001
          // above, this id is deliberately NOT in the mock proposals list,
          // so it renders in the session list (the "proposals fetch
          // failed" fallback the work drawer documents) — which is exactly
          // the card the promoted-cap copy talks about. Appended AFTER
          // totals like every other mock, so the "(x/y)" numerator stays
          // honest and the denominators come from `caps` below.
          {
            id: 990105, branch_name: 'mock/my-proposal-in-vote', pr_number: 990105,
            pr_url: null, pr_title: '[Mock] Proposal up for vote',
            session_title: '[Mock] Proposal up for vote',
            status: 'promoted', linked_issues: [], shared_at: null,
            created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          },
          // #1808: the row PAST the relative form's seven-day floor. Every
          // other mock here is minutes or hours old, so the session rows'
          // stamp read "5m ago" on all of them and the branch that prints a
          // real date was unreachable in a preview. A session parked a
          // fortnight ago is also the case the old code got worst: it
          // bucketed at thirty days and then months, so this row read "0mo
          // ago" once and "5mo ago" later, neither of which is a day.
          {
            id: 990108, branch_name: 'mock/my-session-stale', pr_number: null,
            pr_url: null, pr_title: null,
            session_title: '[Mock] Your session from a couple of weeks ago',
            status: 'active', linked_issues: [], shared_at: null,
            created_at: new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString(),
            last_activity_at: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
            app_slug: config.selfAppSlug, app_name: 'Homeroom', busy: false,
          }
        );
      }
      // #1417: the work the viewer has handed to a coding agent through the
      // connector, which is NOT in chat_sessions and never will be until the
      // agent shares or submits it. Carried on this endpoint rather than a
      // new one because the Improve panel already makes exactly one call
      // here, and a second round trip to say "and three of your own things
      // are also in flight" is a round trip the panel does not need.
      //
      // Deliberately NOT folded into `sessions`, and NOT counted in
      // `totals`: those numbers are the per-user session budget the caps
      // above are the denominators for, and a work order costs the platform
      // no worker, no container and no branch. Putting it there would report
      // a slot as spent that nobody can free by pausing anything.
      const externalTasks = await listOpenWorkOrders(pool, req.user.id);
      // Staging-only demo row (?demo=1), same convention as the mock
      // sessions above: external_agent_tasks is `staging:private`, so a
      // staging clone has NO rows at all and this list is empty for every
      // reviewer. Without a fixture the whole feature is unreviewable in a
      // preview and undeclarable as a check. Read-only and obviously fake.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        externalTasks.push({
          id: 990201,
          issue_number: 900002,
          title: '[Mock] Work handed to a coding agent',
          branch_name: 'usernode/mock-issue-900002',
          agent: 'claude-code',
          created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
          app_slug: config.selfAppSlug,
          app_name: 'Homeroom',
          // The demo row carries an icon too, or the ONE work-order row a
          // preview can show is the one row whose tile falls back to a letter
          // — which is exactly the state a reviewer would read as the bug.
          app_icon_emoji: '\u{1F6E0}\u{FE0F}',
        });
      }
      // Per-viewer denominators for the "(x/y)" header — full admins get
      // the raised caps. Cheap (pure function on req.user, no query).
      // #1766: name the failing checks, and drop the raw results.
      //
      // The card could already say "Checks failing · 3"; it could not say
      // WHICH three, so the owner's only route to that was reading
      // test_results out of the API by hand. Meanwhile the coding agent has
      // been handed the full list, with reasons, in its prompt.
      //
      // Bounded on purpose: test_results holds a row per declared check (500+
      // today) and this endpoint is polled. summarizeFailingChecks caps the
      // rows and carries the totals separately, so the card can say "3 of 528
      // failing" and list the first few without the feed growing with the
      // manifest.
      //
      // IMPORTED rows keep the raw column, because they already had it:
      // enrichImportedUnderwaySessions has been sending it for them since
      // they became proposal-shaped, and me-active-sessions.test.js pins it.
      // Dropping it there would be a silent breaking change to an existing
      // contract in the name of a new one. Everything else selected it only
      // so this summary could be built, so it goes back off the wire.
      for (const row of sessions) {
        if (!row) continue;
        const summary = summarizeFailingChecks(row.check_state, row.test_results);
        if (row.source !== 'imported') delete row.test_results;
        if (summary.total) row.failing_checks = summary;
      }
      // `?results=failing` (services/list-test-results.js): the imported rows
      // above keep their raw results by contract; the shell's list form trims
      // those to the failures too.
      res.json({
        sessions: listTestResults.forListing(req, sessions),
        totals, externalTasks, caps: effectiveSessionCaps(config, req.user),
      });
    } catch (err) {
      log.error('sessions', 'Failed to list active sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/me/session-state[?app=<slug>]
  //   #1038: the reconcile snapshot behind the live `session_state`
  //   WebSocket events. Every "we might have missed something" path on the
  //   client — WS reconnect, a tab returning to the foreground, the slow
  //   safety tick — funnels through this one endpoint, so there is a single
  //   place to reason about convergence.
  //
  //   Deliberately tiny: ids plus flags, no titles, no PR metadata. It
  //   replaces the fast-path role of /api/me/active-sessions +
  //   /shared-sessions + /github-issues for keeping spinners honest, and is
  //   cheap enough to call on every foreground.
  //
  //   Only NON-IDLE rows are returned (sessionState.isIdleState) — absence
  //   means idle. That is what lets the client clear a phantom spinner: it
  //   replaces its whole override set from this response rather than
  //   merging into it.
  //
  //   `bootId` is this platform process's start time. A client that sees a
  //   new value drops every override it holds, which is what unsticks the
  //   UI after a restart or a blue-green cutover (in-memory busy state does
  //   not survive either).
  //
  //   Scope mirrors the surfaces the state feeds:
  //     - always: the viewer's own non-archived sessions;
  //     - with ?app=<slug>, and only behind the same view-level gate
  //       /api/apps/:slug/shared-sessions uses: that app's explicitly
  //       shared sessions and its headless auto-runs, which render on
  //       everyone's board.
  router.get('/api/me/session-state', async (req, res) => {
    try {
      const appSlug = typeof req.query.app === 'string' ? req.query.app : null;

      // One row per candidate session. Kept narrow on purpose: the live
      // predicate below decides what is actually reported, so this only has
      // to be a superset of "could plausibly be non-idle right now".
      const { rows: mine } = await pool.query(
        `SELECT cs.id, cs.status, cs.is_headless, cs.headless_status,
                cs.headless_outcome, cs.headless_issue_number,
                (cs.shared_at IS NOT NULL) AS shared,
                cs.app_id, cs.user_id, a.slug AS app_slug
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE cs.user_id = $1
            AND cs.status IN ('active', 'promoted', 'paused')`,
        [req.user.id]
      );

      let visible = [];
      if (appSlug) {
        // Same view-level gate as /api/apps/:slug/shared-sessions (#621):
        // shared rows are metadata-only, so a read-only viewer may see
        // them. A denied / unknown slug simply contributes nothing —
        // the viewer's own rows above are unaffected.
        const app = await appAccess.getAppForUser(
          pool, appSlug, req.user, 'view', appAccess.ACCESS_COLUMNS
        ).catch(() => null);
        if (app) {
          const { rows } = await pool.query(
            `SELECT cs.id, cs.status, cs.is_headless, cs.headless_status,
                    cs.headless_outcome, cs.headless_issue_number,
                    (cs.shared_at IS NOT NULL) AS shared,
                    cs.app_id, cs.user_id, a.slug AS app_slug
               FROM chat_sessions cs
               JOIN apps a ON a.id = cs.app_id
              WHERE cs.app_id = $1
                AND cs.status IN ('active', 'promoted', 'paused')
                AND (cs.shared_at IS NOT NULL OR cs.is_headless = TRUE)`,
            [app.id]
          );
          visible = rows;
        }
      }

      const byId = new Map();
      for (const row of [...mine, ...visible]) {
        if (byId.has(row.id)) continue;
        const payload = sessionState.buildPayload(
          row.id, row, sessionState.liveState(row.id)
        );
        if (sessionState.isIdleState(payload)) continue;
        byId.set(row.id, {
          id: payload.sessionId,
          appSlug: payload.appSlug,
          // Whose session it is, so the Homeroom mark's working indicator
          // can count the viewer's own work only (SessionState.anyActiveFor).
          userId: payload.userId,
          busy: payload.busy,
          phase: payload.phase,
          stopping: payload.stopping,
          status: payload.status,
          headless: payload.headless,
        });
      }

      const sessions = [...byId.values()];

      // Staging-only demo rows (?demo=1): the sibling endpoints seed mock
      // BUSY cards (the own-session spinner from /api/me/active-sessions,
      // the shared-session spinner from /shared-sessions, the generating
      // auto-run attached to mock issue 900003 in routes/issues.js). Those
      // ids have no in-memory state, so without this block the very first
      // reconcile would report them idle and wipe every demo spinner off
      // the board. Read-only, and a strict no-op in production.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(
          {
            // The viewer's own mock busy session, so the demo's Homeroom
            // mark shows its working indicator (SessionState.anyActiveFor).
            id: 990102, appSlug: config.selfAppSlug, userId: req.user.id, busy: true, phase: 'cc',
            stopping: false, status: 'active', headless: null,
          },
          {
            id: 990001, appSlug: config.selfAppSlug, busy: true, phase: 'cc',
            stopping: false, status: 'active', headless: null,
          },
          {
            id: 990301, appSlug: config.selfAppSlug, busy: true, phase: 'cc',
            stopping: false, status: 'active',
            headless: { status: 'generating', outcome: null, issueNumber: 900003 },
          }
        );
      }

      res.json({ bootId: PROCESS_BOOT_ID, at: Date.now(), sessions });
    } catch (err) {
      log.error('sessions', 'Failed to build session-state snapshot', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List sessions for an app (user's own)
  router.get('/api/apps/:slug/sessions', async (req, res) => {
    try {
      // View-level (#621): the query below is owner-scoped, so a
      // read-only viewer just gets an empty list instead of a 404.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const appRows = [app];

      // has_spec (#894): a boolean, never the spec body — the dev chat's
      // quick-reply fallback picks between the post-build and post-spec
      // pill sets from it, and this list is where DevChat.currentSession
      // comes from. Shipping spec_md itself would put every session's full
      // markdown in a list payload for one bit of information.
      //
      // created_from_issue_number (#1001): lets the STARTER pills — the one
      // set that is legitimately generic, since a fresh session has no
      // conversation to be specific about — name the issue this chat was
      // started for. Already-present metadata; just wasn't serialized.
      //
      // agent_backend / agent_model / source / external_agent: the VENUE a
      // session is building in. Every one of these columns has existed for
      // as long as the feature that writes it, but no list payload carried
      // any of them, so every session card said the same thing no matter
      // where the turns actually ran — and a user whose OpenRouter default
      // had silently fallen back to Claude had no way to see it from the
      // board. Four scalars; no new endpoint, no new column.
      //
      // The pair matters as a pair: `source='imported'` and
      // `external_agent` are what let the card tell "this is building on
      // Homeroom" apart from "this arrived from somewhere else", which is
      // the distinction a bare agent_backend cannot make — an imported row
      // has a defaulted agent_backend that no turn ever ran through.
      const { rows } = await pool.query(
        `SELECT id, branch_name, pr_number, pr_url, pr_title, session_title, staging_url, status, linked_issues, behind_main, shared_at, transcript_shared_at, created_at,
                created_from_issue_number, agent_backend, agent_model, source, external_agent, build_venue,
                -- #2779: the agent session a change was started from, so the
                -- owner's Build door can lead back to that conversation.
                agent_session_id,
                (spec_md IS NOT NULL AND spec_md <> '') AS has_spec,
                -- The same derivation the shared-session list uses, so the
                -- owner's own card and everyone else's card agree about
                -- whether a slept preview can be woken. Without it
                -- _cardPreviewSpec fell back to pr_number, which is null for
                -- a share-only session and left the owner with no affordance
                -- at all once the idle GC nulled staging_url.
                -- #2069: and checks_commit_sha was the same kind of proxy,
                -- null for the same reason. A shared draft has no pull
                -- request AND no checks gate, so both halves were absent
                -- exactly where the comment above says the affordance is
                -- needed. shared_at asks about THIS session instead of a
                -- neighbouring subsystem: the share route verifies a pushed
                -- branch and stamps it at creation, so it is direct evidence
                -- that there is a commit to build.
                (pr_number IS NOT NULL OR checks_commit_sha IS NOT NULL
                   OR shared_at IS NOT NULL)
                  AS can_preview
         FROM chat_sessions
         WHERE app_id = $1 AND user_id = $2 AND is_headless = FALSE
           AND ($3::text IS NULL OR status = $3)
         ORDER BY created_at DESC`,
        // `?status=archived`: the Workshop reads this list only for its
        // "Show archived" rows, and a prolific author's whole history is
        // over a thousand merged rows it discarded on arrival (700 KB on
        // production). Only that one status is accepted; without it the
        // whole list is answered, as it always was.
        [appRows[0].id, req.user.id, req.query.status === 'archived' ? 'archived' : null]
      );

      // `?recent=N`: every session still under way, and only the N newest
      // finished (merged or archived) ones, with a count of the rest. The dev
      // chat's own list asks for it: a prolific author's history on the
      // platform app is over a thousand finished rows (1,015 merged and 97
      // archived, 693 KB on production), re-read on every open of a change
      // and every session event while it is on screen. "Show older" reads
      // the whole list again. Without the parameter it is answered whole.
      const recent = req.query.status === 'archived' ? null : recentFinishedLimit(req.query.recent);
      let listed = rows;
      let olderFinished = 0;
      if (recent) {
        let finished = 0;
        listed = rows.filter((s) => {
          if (!FINISHED_SESSION_STATUSES.has(s.status)) return true;
          finished += 1;
          return finished <= recent;
        });
        olderFinished = rows.length - listed.length;
      }

      // `warm` = a worker container currently exists for the session. The
      // session list uses it to decide whether a promoted row still has a
      // worker to free (and the create-session cap counts the same thing).
      const warmIds = new Set(worker.warmRegistrySnapshot().map((w) => w.sessionId));
      for (const s of listed) s.warm = warmIds.has(s.id);

      // Staging-only demo row (?demo=1): a mock archived session so the
      // "Show archived" toggle — the anchor the visible-sessions group
      // renders beneath — is present for any demo viewer. Same read-only
      // 99xxxx convention as the other mocks (Unarchive 404s server-side).
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        listed.push({
          id: 990104, branch_name: 'mock/archived-session', pr_number: null,
          pr_url: null, pr_title: null,
          session_title: '[Mock] Archived session',
          staging_url: null, status: 'archived', linked_issues: [],
          behind_main: false, shared_at: null, has_spec: false,
          created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          warm: false,
        });
      }

      res.json({ sessions: listed, ...(recent ? { older_finished: olderFinished } : {}) });
    } catch (err) {
      log.error('sessions', 'Failed to list sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/apps/:slug/shared-sessions
  //   Every user's explicitly-shared (shared_at IS NOT NULL) in-flight
  //   sessions on this app — the rows the Dev board renders at the
  //   bottom of everyone's "In progress" area. Ordinary sessions remain
  //   deliberately metadata-only: no pr_url / cc_session_id / anything
  //   enabling dev-chat access — the dev-chat endpoints stay owner-scoped,
  //   so "no way to open the owner's dev chat" is enforced by authorization,
  //   not just missing UI. Imported PR rows are enriched after this privacy
  //   query with the proposal metadata that is already group-visible on
  //   promotion; their GitHub description/checks/attributes exist while
  //   Underway and should not disappear merely because voting has not begun.
  //   staging_url IS included (same exposure /promoted already grants
  //   proposals) so viewers get a Preview affordance,
  //   plus a derived can_preview boolean — "the branch has pushed
  //   changes" — so the card can offer an on-demand rebuild via
  //   ensure-staging even after the idle staging GC has nulled staging_url.
  //   PR number and URL are public GitHub metadata once the author shares a
  //   session. Keep the dev-chat transcript and private work details scoped.
  //
  //   That boolean was `pr_number IS NOT NULL` (#689), which was a fine
  //   proxy while every shared session was a proposal in waiting. It is
  //   not one for a session shared with `share: true`: that lands in the
  //   in-progress area with a preview and NO pull request, so pr_number
  //   is null, can_preview was false, and the card offered nothing at all
  //   the moment the preview went to sleep — to its own author as much as
  //   to anyone else. Meanwhile POST /api/sessions/:id/ensure-staging has
  //   authorized exactly this case all along ("Explicitly-shared sessions
  //   … get the same member-wide access"): the server said yes and the
  //   affordance never asked.
  //
  //   checks_commit_sha is the durable half of the answer. It records the
  //   commit a checks run described, so it is only ever set once a real
  //   commit on this branch has been built — and unlike staging_url,
  //   staging_image_ref and staging_build_ref, teardownStaging does not
  //   clear it. It survives exactly the event that used to strand the
  //   card.
  //   chat_count / last_message_at mirror the /promoted subqueries: the
  //   discussion thread is the same chat_messages ('session', id) key
  //   the proposal card will inherit on promotion. linked_issues IS
  //   included — issue numbers are group-visible data (the issue list
  //   itself is view-level), and the card renders them as "#N" chips
  //   linking to each issue's in-app discussion.
  //   check_state / check_phase are the same review-state metadata the
  //   promoted feed exposes. They let an ordinary explicitly shared
  //   Underway card say that its preview is building, tests are running, or
  //   checks have finished without exposing the test result payload or
  //   error detail. Imported rows receive those full details in the scoped
  //   enrichment described above.
  //
  //   `transcript_shared` (+ `message_count` for its label) is the ONE
  //   addition that widens what a viewer can reach: it says the owner took
  //   the second opt-in and published the conversation, so the card renders
  //   a "Read chat" chip. Note what it still is NOT — the transcript itself
  //   is not inlined here; the chip routes to GET /transcript, which
  //   re-checks both flags server-side. This endpoint stays metadata-only.
  router.get('/api/apps/:slug/shared-sessions', async (req, res) => {
    try {
      // View-level (#621): explicitly-shared rows are metadata-only by
      // design, so read-only viewers may see them.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT cs.id, cs.session_title, cs.pr_title, cs.pr_number, cs.pr_url,
                cs.branch_name, cs.status,
                cs.staging_url,
                -- #2069, as above: a shared draft has neither a pull request
                -- nor a checks run, and shared_at is the session's own
                -- evidence that a verified branch was pushed.
                (cs.pr_number IS NOT NULL OR cs.checks_commit_sha IS NOT NULL
                   OR cs.shared_at IS NOT NULL)
                  AS can_preview,
                cs.linked_issues, cs.source, cs.imported_pr_author,
                cs.agent_backend, cs.agent_model, cs.external_agent, cs.build_venue,
                cs.check_state, cs.check_phase,
                (cs.transcript_shared_at IS NOT NULL) AS transcript_shared,
                (SELECT COUNT(*)::int FROM chat_session_messages m
                  WHERE m.session_id = cs.id) AS message_count,
                cs.user_id, COALESCE(u.username, 'Deleted user') AS username, cs.shared_at, cs.created_at,
                GREATEST(cs.created_at, COALESCE(m.last_message_at, cs.created_at)) AS last_activity_at,
                (SELECT COUNT(*)::int FROM chat_messages cm
                  WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
                    AND cm.msg_type = 'message') AS chat_count,
                (SELECT MAX(cm.created_at) FROM chat_messages cm
                  WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id) AS last_message_at
         FROM chat_sessions cs
         LEFT JOIN users u ON u.id = cs.user_id
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_message_at
           FROM chat_session_messages
           WHERE session_id = cs.id
         ) m ON TRUE
         WHERE cs.app_id = $1 AND cs.shared_at IS NOT NULL
           AND cs.status IN ('active', 'paused') AND cs.is_headless = FALSE
         ORDER BY cs.shared_at ASC`,
        [app.id]
      );
      let sessions = rows.map((s) => ({
        ...s,
        busy: isSessionBusy(s.id),
      }));
      sessions = await enrichImportedUnderwaySessions(pool, sessions, req.user?.id || null);

      // Staging-only demo rows (?demo=1): read-only visual states a boot
      // seed can't hold live (busy spinner, Preview pill). Fake ids in the
      // 99xxxx range and user_id 0 so they can never collide with the
      // viewer or a real session; opening their discussion just shows an
      // empty thread (validateThread rejects posts on nonexistent rows).
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        sessions.push(...stagingMockSharedSessions());
      }

      // `?results=failing`: the shell's list form (services/list-test-results.js).
      res.json({ sessions: listTestResults.forListing(req, sessions) });
    } catch (err) {
      log.error('sessions', 'Failed to list shared sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a new session. No branch and no PR yet (#1350): the branch is
  // minted on the first chat turn, the PR after the first commit.
  router.post('/api/apps/:slug/sessions', drainGuard, communities.requireAppMembership(pool), async (req, res) => {
    try {
      // #2779: only an agent session's Mayor starts a change (a delegated
      // grant that names the session); a classic session is no longer
      // created for anyone else. See CLASSIC_SESSIONS_RETIRED.
      const agentSessionId = req.mcpDelegation && req.mcpDelegation.kind === 'agent_mayor'
        ? req.mcpDelegation.agentSessionId || null : null;
      if (!agentSessionId) {
        return res.status(403).json({ error: CLASSIC_SESSIONS_RETIRED, code: 'agent_sessions_only' });
      }

      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      // No repo → every chat turn on the session would refuse to run
      // (see the repo guard in POST /chat), so reject up front like the
      // headless route does. Deliberately unconditional (also when GitHub
      // is disabled platform-wide): a clear 400 beats a session whose
      // every turn dies, and on GitHub-enabled deployments the app-heal
      // sweep makes this state short-lived.
      if (!(app.repo_url || '').match(/github\.com\/[^/]+\/[^/]+/)) {
        return res.status(400).json({ error: 'No GitHub repo configured for this app' });
      }

      // #2779: an optional name, as the user would call the change. The
      // agent-session Mayor's start_change sends one; the browser buttons
      // do not, and their sessions are named from the first message. It is
      // the change's display name, not a title a person chose: it does NOT
      // go in proposed_pr_title, which outranks every generated title and
      // would pin the proposal to the Mayor's first guess. pr-metadata reads
      // it back (from the change_started event) as the change's request, so
      // the title and description are written from the change itself.
      // PATCH /api/sessions/:id/title is how a person pins one.
      let initialTitle = null;
      if (req.body && req.body.title != null) {
        initialTitle = typeof req.body.title === 'string'
          ? req.body.title.replace(/\s+/g, ' ').trim() : '';
        if (!initialTitle || initialTitle.length > MANUAL_SESSION_TITLE_MAX) {
          return res.status(400).json({
            error: `Title must be 1 to ${MANUAL_SESSION_TITLE_MAX} characters`,
          });
        }
      }

      // #2779: the new change becomes the Mayor's session's active change,
      // and the one it was working on is parked first — which also frees its
      // slot before the cap below counts it. The grant's own liveness check
      // has already refused an archived or foreign session; this re-checks
      // at the write.
      if (agentSessionId) {
        try {
          await agentSessions.prepareChangeStart(pool, { agentSessionId, userId: req.user.id });
        } catch (err) {
          if (err instanceof agentSessions.AgentSessionError) {
            return res.status(err.status).json({ error: err.message });
          }
          throw err;
        }
      }

      // Per-user cap (#193): only 'active' sessions count toward the
      // slot budget. Promoted sessions (PRs up for a merge vote) are
      // deliberately un-pausable — their status must stay 'promoted' so
      // the vote endpoints keep working — so counting them here would
      // leave the user no way to free a slot by pausing. The separate
      // promoted cap (enforced at promote time) bounds how many
      // vote-only sessions one user can accumulate.
      //
      // The ceiling itself is per-REQUESTER: full platform admins get a
      // raised cap (services/session-caps.js). Never compare against
      // config.maxUserSessions directly here.
      const caps = effectiveSessionCaps(config, req.user);
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE
           AND source IS DISTINCT FROM 'imported'`,
        [req.user.id]
      );
      // At the cap, the least recently used of the user's own sessions is
      // paused for them (session-lifecycle.freeUserSlot): pausing keeps
      // everything and opening it resumes it, so nobody is asked to manage it.
      if (parseInt(countRows[0].cnt) >= caps.activeSessions) {
        const { freed } = await sessionLifecycle.freeUserSlot({ pool, userId: req.user.id });
        if (!freed) return res.status(429).json({ error: sessionLifecycle.USER_SLOTS_BUSY });
      }

      // A browser that offers the coding-agent picker sends `backend`
      // explicitly. Honor that exact choice and fail closed if it is not
      // usable; legacy/API clients that omit it keep the saved-default
      // behavior. Resolve before global LRU reclamation or GitHub branch
      // creation so an invalid selection has no external side effects.
      //
      // #2779: a change an agent session starts is created on that
      // conversation's model choice (its composer's picker), held to the same
      // exact-or-refuse rule as a browser's explicit pick. A conversation
      // with no choice follows the saved default like any other caller.
      let pref;
      try {
        const explicitAgent = req.body
          && Object.prototype.hasOwnProperty.call(req.body, 'backend');
        const conversationChoice = !explicitAgent && agentSessionId
          ? await agentSessions.getAgentChoice(pool, agentSessionId)
          : null;
        if (explicitAgent) {
          pref = await resolveExplicitAgentPreference(pool, req.user.id, config, req.body);
        } else if (conversationChoice) {
          pref = await resolveExplicitAgentPreference(pool, req.user.id, config, conversationChoice);
        } else {
          pref = await resolveDefaultAgentPreference(pool, req.user.id, config);
        }
      } catch (err) {
        if (err instanceof AgentSelectionError) {
          return res.status(err.statusCode).json(agentSelectionErrorBody(err));
        }
        throw err;
      }

      // The GLOBAL ceiling has no admin tier — it's the host's coding-worker
      // budget, not a policy privilege, so full admins queue behind it like
      // everyone else. Imported PRs are produced externally and own no
      // Homeroom worker, so they do not spend this budget.
      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
          WHERE status IN ('active', 'promoted')
            AND source IS DISTINCT FROM 'imported'
            AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        // At the global cap: try to reclaim a slot from a globally idle
        // session (idle past the pressure grace window, not mid-turn)
        // instead of making this user wait for the slow 2h auto-pause.
        // Only 429 if everything is genuinely active.
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      // #287: an optional issue number links this dev chat back to the
      // issue row's "Create PR" button so the row can swap to "Open
      // Session" for this viewer. Validate to a positive integer; anything
      // else (incl. the generic "+ New chat" path that sends no body)
      // stores NULL.
      const rawIssue = req.body && req.body.issueNumber;
      const issueNumber = Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;

      // #1350: NO branch is minted here. The row is created with
      // branch_name NULL and the branch appears the first time something
      // actually needs it — the first chat turn, via
      // sessionLifecycle.ensureSessionBranch(). Two reasons:
      //
      //   * Most created sessions never run a turn. The start screen, the
      //     issue panel's "Create PR" and the "+ New chat" button all land
      //     here, and an abandoned session used to leave an empty ref off
      //     main behind it forever.
      //   * A session handed to an off-platform venue (web-claude-code,
      //     web-codex, own-tools-pr) runs no on-platform turn at all. Its
      //     agent pushes to its own fork, so a platform branch for it was
      //     never anything but litter.
      //
      // Everything downstream already tolerates the NULL: the venue sheet
      // reads `hasBranch`, the staging/heal sweeps filter
      // `branch_name IS NOT NULL`, and the four seams that genuinely
      // require a ref call ensureSessionBranch() themselves.
      //
      // Insert the session with its FINAL chosen/default backend and model
      // atomically — never insert-then-patch. An explicit choice was strictly
      // validated above; an omitted choice preserves the saved-default path.
      // #2500 / #2537: starting work on an issue IS addressing it, so the
      // link is seeded here rather than waiting for the Mayor to declare it
      // with `addresses_issues` — which it never does on an OpenRouter or
      // direct-agent turn, because those emit no Mayor tool at all. Without
      // this the proposal read "No issues linked yet" and its PR body got
      // no `Closes #N`, even though the issue board linked back to the
      // session the whole time (issue-proposal-ref.js unions
      // created_from_issue_number in; the "Addresses" chips and the closing
      // block read linked_issues alone). The Mayor's declarations and the
      // linked-issues editor still add and remove on top of this; the
      // seeded flag records that this row's linkage has been initialised, so
      // an author who removes the issue keeps it removed.
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, created_from_issue_number,
            linked_issues, issue_link_seeded,
            agent_backend, agent_provider, agent_model, agent_reasoning_effort,
            session_title)
         VALUES ($1, $2, NULL, 'active', $3, $4, $5, $6, $7, $8, $9, $10::text)
         RETURNING *`,
        [app.id, req.user.id, issueNumber,
         issueNumber ? [issueNumber] : [], !!issueNumber,
         pref.backend, pref.provider, pref.model, pref.reasoningEffort,
         initialTitle]
      );
      await topicAttrs.selfAssignProposal(pool, app.id, rows[0].id, req.user);
      if (agentSessionId) {
        await agentSessions.linkChange(pool, {
          agentSessionId,
          userId: req.user.id,
          change: { ...rows[0], app_slug: app.slug, app_name: app.name },
        });
      }

      log.info('sessions', 'Session created (branch deferred to first turn)', { sessionId: rows[0].id });

      // #2364: "Start work" on an issue card lands here, and starting work
      // on an issue is taking it — so claim it for the starter (claim row +
      // assignee vote, exactly what the Claim button does). The number is
      // client input, so it is claimed only once GitHub confirms it names an
      // OPEN issue on this app's repo; with GitHub disabled nothing can
      // confirm it and nothing is claimed. Awaited rather than fired off so
      // the board the client returns to already shows the claim:
      // fetchPublicIssue is cache-first (the board that offered the button
      // just filled that cache) and never throws. Best-effort — a failed
      // claim never fails the session it rides on.
      if (issueNumber) {
        const [, repoOwner, repoName] = String(app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (github.isEnabled() && repoOwner && repoName) {
          try {
            const { issue } = await github.fetchPublicIssue(repoOwner, repoName.replace(/\.git$/, ''), issueNumber);
            if (issue && issue.state !== 'closed') {
              await claimIssueForUser(pool, { app, issueNumber, user: req.user });
            }
          } catch (err) {
            log.warn('sessions', 'Issue claim on session start failed', {
              sessionId: rows[0].id, issueNumber, err: err.message,
            });
          }
        }
      }

      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: app.id,
        sessionId: rows[0].id,
      });
      // agentFallbackReason: the saved default could not be honoured and a
      // Homeroom · Claude session was created instead. The row itself only
      // records WHAT was chosen, so the reason rides alongside it and the
      // chat renders one sentence naming it. Absent when nothing fell back
      // — the client must not have to distinguish "no fallback" from
      // "fallback with an unknown cause".
      res.status(201).json({
        session: rows[0],
        ...(pref.fallbackReason ? { agentFallbackReason: pref.fallbackReason } : {}),
      });
    } catch (err) {
      log.error('sessions', 'Failed to create session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #155: start a HEADLESS auto session for a GitHub issue.
  //
  // Unlike POST /sessions this is not connected to any user's dev chat: it
  // runs ONE unattended Mayor turn (scout → spec, build → pushed commit, or
  // a plain-text question) seeded with the issue, then parks as
  // headless_status='ready' so any collaborator can clone it via
  // POST /api/sessions/:id/clone-headless. Billed to the clicking user,
  // limit-first (#212): their daily budget while it lasts, then their BYOK
  // key when on file — the UI shows a confirmation warning + model
  // selector before calling this.
  //
  // The run may create + push its branch and deliberately builds a staging
  // preview, but never opens a PR — the PR is created lazily on a cloned
  // session's branch at propose time (see runClaudeCodeTool's `headless`
  // flag).
  router.post('/api/apps/:slug/issues/:number/headless-session', drainGuard, communities.requireAppMembership(pool), async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      const issueNumber = parseInt(req.params.number, 10);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        return res.status(400).json({ error: 'Invalid issue number' });
      }

      const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!github.isEnabled() || !repoOwner || !repoName) {
        return res.status(400).json({ error: 'No GitHub repo configured for this app' });
      }

      // Resolve the actual saved backend before any provider-specific gate.
      // An OpenRouter default does not require an Anthropic configuration or
      // allowance just to start an unattended run.
      let pref;
      try {
        const explicitAgent = req.body
          && Object.prototype.hasOwnProperty.call(req.body, 'backend');
        pref = explicitAgent
          ? await resolveExplicitAgentPreference(pool, req.user.id, config, req.body)
          : await resolveDefaultAgentPreference(pool, req.user.id, config);
      } catch (err) {
        if (err instanceof AgentSelectionError) {
          return res.status(err.statusCode).json(agentSelectionErrorBody(err));
        }
        throw err;
      }
      const isOpenRouterSession = pref.backend === 'codex_openrouter';
      if (!isOpenRouterSession && !llm.isEnabled()) {
        return res.status(503).json({ error: 'LLM not configured' });
      }

      // One auto session per issue at a time: 'generating' means a run is
      // in flight; 'ready' means the start-from button should be used
      // instead. 'failed' rows don't block a retry, and neither does a
      // 'ready' run that ended with outcome 'question' (#150) — the whole
      // point is to answer on the issue and press Generate proposal again.
      const { rows: existingRows } = await pool.query(
        `SELECT id, headless_status FROM chat_sessions
         WHERE app_id = $1 AND is_headless = TRUE AND headless_issue_number = $2
           AND headless_status IN ('generating', 'ready')
           AND NOT (headless_status = 'ready' AND headless_outcome = 'question')
         ORDER BY created_at DESC LIMIT 1`,
        [app.id, issueNumber]
      );
      if (existingRows.length) {
        return res.status(409).json({
          error: existingRows[0].headless_status === 'generating'
            ? 'An auto session is already being generated for this issue.'
            : 'This issue already has a ready auto session. Start a session from it instead.',
        });
      }

      // Billed to the clicking user, limit-first (#212): their shared
      // daily allowance while it has headroom, their BYOK key once it's
      // exhausted — exactly like a chat turn. No headroom + no key → 429.
      // The code lets the client tell budget exhaustion apart from a
      // rate-limit 429 (#463).
      // OpenRouter runs bill only the user's OpenRouter key. Claude runs keep
      // the existing limit-first platform/BYOK preflight.
      let billing = { apiKey: null };
      if (!isOpenRouterSession) {
        billing = await limits.resolveBillingPath(pool, config.dataEncryptionKey, req.user.id);
        if (billing.error) return res.status(429).json({
          error: billing.error,
          code: 'budget_exceeded',
          reason: billing.reason || null,
          verificationRequired: !!billing.verificationRequired,
        });
      }
      const userApiKey = billing.apiKey;

      // Headless sessions don't count against the clicking user's session
      // cap (they're shared, unattended work — see the cap query in POST
      // /sessions), but they consume a real worker slot, so the global cap
      // still applies.
      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
          WHERE status IN ('active', 'promoted')
            AND source IS DISTINCT FROM 'imported'
            AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      const selectedModel = models.resolve(req.body && req.body.model);

      // Full issue text for the seed turn (cache-first; degrades to a
      // number-only seed when GitHub can't be reached right now). The
      // issue's comments ride along (#150) so answers to earlier
      // auto-solve questions are visible to this run; a failed comments
      // fetch degrades to title + body. The bot username lets the seed
      // tag the bot's own earlier question comments.
      const { issue } = await github.fetchPublicIssue(repoOwner, repoName, issueNumber);
      const { comments } = await github.fetchIssueComments(repoOwner, repoName, issueNumber);
      let botUsername = null;
      try { botUsername = await github.getBotUsername(); } catch {}

      // #1350 carve-out: a headless run mints its branch here, up front,
      // and deliberately does NOT defer. There is no "first message" to
      // defer to — the route's whole job is to start one unattended turn
      // immediately, and that turn may push. Deferring would only move the
      // same mint a few lines down the same request.
      const branchName = branchNames.devBranchName(`auto-issue-${issueNumber}`);
      try {
        await github.createBranch(repoOwner, repoName, branchName);
      } catch (err) {
        log.warn('sessions', 'GitHub branch creation failed (continuing)', { err: err.message });
      }

      // #249: deterministic display name — "#N · issue title" — set at
      // creation (no LLM call), so the auto session is named both while
      // generating and after. Null when the issue fetch degraded to
      // number-only; the UI then falls back to the branch name.
      const autoTitle = sessionTitles.headlessTitle(issueNumber, issue && issue.title);

      // linked_issues is seeded with the issue so a PR opened later from a
      // CLONED session carries `Closes #N` (the clone copies the linkage).
      // #2500: and `issue_link_seeded`, so the promote-time backfill knows
      // this row's linkage was initialised here — the interactive create
      // path above does the same thing now.
      // plan 9 (Commit 7): carry the final default backend/model in the
      // insert — no insert-then-patch for headless sessions either.
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, headless_status, headless_issue_number, linked_issues, issue_link_seeded, session_title,
            agent_backend, agent_provider, agent_model, agent_reasoning_effort)
         VALUES ($1, $2, $3, 'active', TRUE, 'generating', $4, $5, TRUE, $6, $7, $8, $9, $10)
         RETURNING *`,
        [app.id, req.user.id, branchName, issueNumber, [issueNumber], autoTitle,
         pref.backend, pref.provider, pref.model, pref.reasoningEffort]
      );
      const session = rows[0];
      // The runner reuses chat-handler helpers that expect the app fields
      // joined onto the session row.
      session.app_slug = app.slug;
      session.app_name = app.name;
      session.repo_url = app.repo_url;
      session.app_self_hosted = app.self_hosted;

      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: app.id,
        sessionId: session.id,
        metadata: { headless: true, issueNumber },
      });

      // #2364: generating a proposal for an issue is taking it, so claim it
      // for the clicking user (claim row + assignee vote, as the Claim
      // button does). Only an issue the fetch above positively returned as
      // open — a degraded, number-only fetch confirms nothing. Best-effort:
      // the run starts either way.
      if (issue && issue.state !== 'closed') {
        await claimIssueForUser(pool, {
          app, issueNumber, user: { id: req.user.id, username: req.user.username },
        }).catch((err) => log.warn('sessions', 'Issue claim on headless start failed', {
          sessionId: session.id, issueNumber, err: err.message,
        }));
      }

      // #1038: the row is now 'generating', which is what puts the spinner
      // on this issue's kanban card for every viewer of the app. Nothing in
      // the in-memory registries has moved yet (the runner below is
      // fire-and-forget), so announce the row write itself.
      sessionState.touch(session.id);

      // Fire-and-forget: the run continues after this response. Failures
      // inside the runner mark the row 'failed' (and a platform restart
      // mid-run is swept to 'failed' at boot — see migrate.js).
      runHeadlessSession({
        pool, config, session,
        user: { id: req.user.id, username: req.user.username },
        selectedModel, repoOwner, repoName, userApiKey,
        issueNumber, issue, comments, botUsername,
      }).catch((err) => {
        log.error('sessions', 'Headless session runner crashed', { sessionId: session.id, err: err.message, stack: err.stack });
      });

      log.info('sessions', 'Headless session started', { sessionId: session.id, issueNumber, model: selectedModel });
      // See POST /sessions: the same named flag/beta policy fallback.
      res.status(201).json({
        session,
        ...(pref.fallbackReason ? { agentFallbackReason: pref.fallbackReason } : {}),
      });
    } catch (err) {
      log.error('sessions', 'Failed to start headless session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #155: clone a READY headless auto session into the caller's own dev
  // chat. Any collaborator can do this (the sessionCollabGuard above
  // enforces collab access), and many users can clone the same auto
  // session independently — each clone gets its own branch (forked off the
  // auto session's branch so pushed commits carry over), a copy of the
  // chat history + spec, and (best-effort) the auto session's Claude Code
  // memory volume so the agent resumes with full context. A follow-up
  // assistant message tells the new owner where things stand and how to
  // proceed (review spec / answer question / ask for PR + staging).
  //
  // #2779: the browser no longer clones a run into a classic dev chat (its
  // "Start work" on a finished run opens an agent session instead). The
  // hosted connector's submit_platform_build still takes ownership of a
  // build this way before proposing it, so an external connector token (not
  // a delegated grant) is the one caller left.
  router.post('/api/sessions/:id/clone-headless', drainGuard, communities.requireSessionMembership(pool), async (req, res) => {
    if (!req.connectorClientId || req.mcpDelegation) {
      return res.status(403).json({ error: CLASSIC_SESSIONS_RETIRED, code: 'agent_sessions_only' });
    }
    try {
      const { rows: srcRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.is_headless = TRUE`,
        [req.params.id]
      );
      if (!srcRows.length) return res.status(404).json({ error: 'Auto session not found' });
      const src = srcRows[0];
      if (src.headless_status !== 'ready') {
        return res.status(409).json({
          error: src.headless_status === 'generating'
            ? 'The auto session is still generating. Try again when it finishes.'
            : 'This auto session is not in a cloneable state.',
        });
      }

      // The clone is an ordinary dev-chat session, so the usual caps apply.
      // Per-user cap counts only 'active' sessions (#193) — promoted ones
      // are un-pausable while their PR is in a vote, so they're exempt —
      // and the ceiling is per-requester (full admins get a raised cap;
      // see services/session-caps.js).
      const caps = effectiveSessionCaps(config, req.user);
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE
           AND source IS DISTINCT FROM 'imported'`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= caps.activeSessions) {
        const { freed } = await sessionLifecycle.freeUserSlot({ pool, userId: req.user.id });
        if (!freed) return res.status(429).json({ error: sessionLifecycle.USER_SLOTS_BUSY });
      }

      // Resolve (and, for a first-time eligible user, provision) the coding
      // agent before reclaiming a global slot or creating a GitHub branch.
      // A deployment/provisioning failure must leave no clone side effects.
      let pref;
      try {
        pref = await resolveDefaultAgentPreference(pool, req.user.id, config);
      } catch (err) {
        if (err instanceof AgentSelectionError) {
          return res.status(err.statusCode).json(agentSelectionErrorBody(err));
        }
        throw err;
      }

      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
          WHERE status IN ('active', 'promoted')
            AND source IS DISTINCT FROM 'imported'
            AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      // Fork the new branch off the auto session's branch so any commit it
      // pushed carries over. Fall back to main if that branch is missing
      // (e.g. the headless run never pushed and the branch was pruned).
      //
      // #1350 carve-out: this mint is NOT deferred. The clone exists to
      // inherit the headless run's commits, and that inheritance is the
      // `fromBranch` argument below. Defer it and the first turn would
      // branch off main instead, silently discarding the work the clone
      // was created to continue.
      const branchName = branchNames.devBranchName(req.user.username);
      const [, repoOwner, repoName] = (src.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      let inheritedCodeBranch = false;
      if (github.isEnabled() && repoOwner && repoName) {
        try {
          await github.createBranch(repoOwner, repoName, branchName, src.branch_name || 'main');
          inheritedCodeBranch = !!src.branch_name;
        } catch (err) {
          log.warn('sessions', 'Branch fork off auto session failed — falling back to main', { err: err.message, from: src.branch_name });
          try {
            await github.createBranch(repoOwner, repoName, branchName);
          } catch (err2) {
            log.warn('sessions', 'GitHub branch creation failed (continuing)', { err: err2.message });
          }
        }
      }

      // #249: the clone inherits the auto session's display name.
      // Sources that predate session_title fall back to the same
      // "#N · issue title" derivation (best-effort, cache-first fetch
      // — a failure just leaves the branch-name fallback).
      let cloneTitle = src.session_title || null;
      if (!cloneTitle && src.headless_issue_number && github.isEnabled() && repoOwner && repoName) {
        try {
          const { issue } = await github.fetchPublicIssue(repoOwner, repoName, src.headless_issue_number);
          cloneTitle = sessionTitles.headlessTitle(src.headless_issue_number, issue && issue.title);
        } catch (err) {
          log.warn('sessions', 'Issue fetch for clone title failed (continuing untitled)', { err: err.message });
        }
      }

      // plan 9 (Commit 7): the clone is inserted with its final
      // default backend/model atomically (no insert-then-patch).
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, spec_md, linked_issues, testing_md, testing_path, testing_paths, cloned_from_session_id, session_title,
            agent_backend, agent_provider, agent_model, agent_reasoning_effort)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [src.app_id, req.user.id, branchName, src.spec_md || '', src.linked_issues, src.testing_md, src.testing_path,
         src.testing_paths != null ? JSON.stringify(src.testing_paths) : null, src.id, cloneTitle,
         pref.backend, pref.provider, pref.model, pref.reasoningEffort]
      );
      const session = rows[0];
      await topicAttrs.selfAssignProposal(pool, src.app_id, session.id, req.user);

      // Copy the conversation so the Mayor (and the new owner) see the full
      // auto-session context. Costs are zeroed — the cloner didn't pay for
      // the original run and the per-message figures would double-count.
      //
      // #647: every copied row is stamped with `inheritedFrom` (the auto
      // session's id). The clone loses created_at (not copied — the rows get
      // clone-time timestamps) and the new ids are contiguous with the
      // human's own later turns, so this marker is the only durable signal
      // separating "history the auto session produced" from "work this
      // session did for me". The dev-chat renderer keys the collapsed-by-
      // default state of the Claude Code disclosures off it. The follow-up
      // row appended below deliberately does NOT carry it — that message
      // belongs to the human session.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, metadata)
         SELECT $1, role, content, model,
                COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('inheritedFrom', $2::int)
         FROM chat_session_messages WHERE session_id = $2 ORDER BY id ASC`,
        [session.id, src.id]
      );
      // Carry the spec version history too, so the spec viewer shows v1…vN.
      await pool.query(
        `INSERT INTO chat_session_specs (session_id, version, content, built_at, commit_sha, pr_number)
         SELECT $1, version, content, built_at, commit_sha, pr_number
         FROM chat_session_specs WHERE session_id = $2`,
        [session.id, src.id]
      ).catch((err) => log.warn('sessions', 'Spec history copy failed (continuing)', { err: err.message }));

      // The unattended source remains PR-free. Once someone clones its code
      // into their own session, the inherited pushed diff belongs to a human
      // change and can be reviewed on a draft PR immediately.
      if (inheritedCodeBranch && ['code', 'spec_code'].includes(src.headless_outcome)) {
        try {
          await prMetadata.applyPrMetadata({
            pool, session, repoOwner, repoName,
            userMessage: '', ccSummary: '', username: req.user.username,
            userId: req.user.id, allowModelGeneration: false,
            preferredTitle: cloneTitle || null,
          });
        } catch (err) {
          log.warn('sessions', 'Draft PR creation deferred after headless clone', {
            sessionId: session.id, code: err.code || null, err: err.message,
          });
        }
      }

      // Best-effort: clone the auto session's CC memory volume so --resume
      // continues its conversation. On failure the clone simply starts with
      // fresh CC memory (chat history + spec still carry the context).
      if (src.cc_session_id) {
        try {
          await worker.cloneCcVolume(src.id, session.id);
          await pool.query(`UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`, [src.cc_session_id, session.id]);
          session.cc_session_id = src.cc_session_id;
        } catch (err) {
          log.warn('sessions', 'CC volume clone failed — clone starts with fresh CC memory', { src: src.id, dest: session.id, err: err.message });
        }
      }

      // The promised follow-up (#155): an assistant message telling the new
      // owner where the auto session left off and what to do next.
      //
      // #32: chips render only under the LAST non-system message, which is
      // this follow-up. When the auto session ended in a question, look up
      // the suggestions persisted on its question turn (the source's most
      // recent assistant message with a non-empty metadata.suggestions) and
      // forward them onto the follow-up so the answer chips render under it.
      // spec/code/spec_code outcomes have no questions — they stay chip-free.
      let followUpSuggestions = null;
      if (src.headless_outcome === 'question') {
        const { rows: suggRows } = await pool.query(
          `SELECT metadata FROM chat_session_messages
           WHERE session_id = $1 AND role = 'assistant'
             AND jsonb_array_length(COALESCE(metadata->'suggestions', '[]'::jsonb)) > 0
           ORDER BY id DESC LIMIT 1`,
          [src.id]
        );
        if (suggRows.length) {
          const s = suggRows[0].metadata && suggRows[0].metadata.suggestions;
          if (Array.isArray(s) && s.length) followUpSuggestions = s;
        }
      }
      // #330: spec/code/spec_code clones get next-step pills (the question
      // path stays pill-free — its answer chips take precedence).
      //
      // #1001: those pills used to be a fixed triple, and production showed
      // 92 sessions opening on exactly "Propose it to the group / Revise the
      // spec / Make a tweak" — generic despite the auto run having produced
      // a specific plan or commit. There is no Mayor reply on a clone to
      // attach a tool call to, so the forced pills-only call IS the only way
      // the assistant authors these; the static set stays as the fallback.
      const staticFollowUpPills = buildHeadlessFollowUpQuickReplies(src);
      const followUp = buildHeadlessFollowUpMessage(src);
      let followUpPills = null;
      if (staticFollowUpPills) {
        const { rows: srcTail } = await pool.query(
          `SELECT role, content FROM chat_session_messages
           WHERE session_id = $1 AND role IN ('user', 'assistant')
           ORDER BY id DESC LIMIT 6`,
          [src.id]
        ).catch(() => ({ rows: [] }));
        followUpPills = await resolveTurnPills({
          pool,
          dataKey: config.dataEncryptionKey,
          // `src` (not the fresh row) because it carries app_name from its
          // JOIN — the new session row has only its own columns.
          session: { id: session.id, app_name: src.app_name },
          userId: req.user.id,
          apiKey: null,
          model: null,
          modelPills: null,
          outcome: src.headless_outcome === 'spec' ? 'spec_done' : 'build_done',
          hasPr: !!session.pr_number,
          hasSpec: !!(src.spec_md || '').trim(),
          staticFallback: staticFollowUpPills,
          replyText: followUp,
          transcriptTail: srcTail.slice().reverse(),
          state: [
            src.headless_issue_number ? `cloned from an auto session on GitHub issue #${src.headless_issue_number}` : 'cloned from an auto session',
            `the auto run produced: ${src.headless_outcome}`,
            (src.spec_md || '').trim() ? `spec first heading: ${((src.spec_md || '').match(/^#{1,2} +(.+)$/m) || [])[1] || '(untitled)'}` : 'no spec',
          ].join('; '),
        });
        log.info('sessions', 'quick replies resolved', {
          sessionId: session.id, phase: 'clone-followup',
          source: followUpPills.source, kind: followUpPills.kind || null,
        });
      }
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
        [session.id, followUp, JSON.stringify({
          ...(followUpSuggestions ? { suggestions: followUpSuggestions } : {}),
          ...quickReplyMeta(followUpPills),
        })]
      );

      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: src.app_id,
        sessionId: session.id,
        metadata: { clonedFrom: src.id, headlessIssue: src.headless_issue_number },
      });

      // #161 auto-dismiss: cloning the auto session resolves its
      // completion notification for the cloner. Fire-and-forget;
      // cross-tab badge sync only when something actually cleared.
      notifications.markReadForAction(pool, req.user.id, 'headless_cloned', src.id)
        .then((cleared) => {
          if (cleared > 0) {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          }
        })
        .catch((err) => log.warn('sessions', 'headless_cloned dismiss failed', { err: err.message }));

      log.info('sessions', 'Cloned headless session', { src: src.id, sessionId: session.id, user: req.user.username });
      // See POST /sessions: the same named flag/beta policy fallback.
      res.status(201).json({
        session,
        ...(pref.fallbackReason ? { agentFallbackReason: pref.fallbackReason } : {}),
      });
    } catch (err) {
      log.error('sessions', 'Failed to clone headless session', { message: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Check results are fetched on demand, separately from the private dev
  // transcript and the lightweight board feed. The app view gate above still
  // applies; sharing a session exposes these results, never its messages.
  router.get(['/api/sessions/:id/checks', '/api/sessions/:id/details'], async (req, res) => {
    try {
      if (req.path.endsWith('/details') && process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        const mock = stagingMockSharedSessions().find((s) => s.id === Number(req.params.id))
          || (Number(req.params.id) === 990101
            ? stagingMockOwnSession(req.user.id, config.selfAppSlug) : null);
        if (mock) return res.set('Cache-Control', 'no-store').json({ session: mock });
      }
      const { rows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.status, cs.shared_at, cs.transcript_shared_at, cs.session_title, cs.pr_title,
                cs.check_state, cs.check_phase, cs.check_trigger,
                cs.check_error_detail, cs.checks_checked_at, cs.checks_commit_sha,
                cs.checks_progress, cs.test_results, cs.checks_base_sha,
                cs.checks_base_verdict, cs.checks_base_behind_by,
                cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha,
                cs.shots_state, cs.shots_run_id,
                cs.shots_detail, cs.shots_updated_at,
                a.slug AS app_slug
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1`,
        [parseInt(req.params.id, 10)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];
      if (!canViewSession(session, req.user)) return res.status(404).json({ error: 'Session not found' });
      const detail = req.path.endsWith('/details')
        ? (await enrichImportedUnderwaySessions(pool, [session], req.user.id, { all: true }))[0]
        : session;
      if (req.path.endsWith('/details')) {
        detail.busy = isSessionBusy(Number(session.id));
        // #2371: the author reviews a change before submitting it, and before
        // then its only description is the spec. Read separately and only for
        // the owner of an underway change, so the shared projection above
        // never carries it (#894).
        if (session.user_id === req.user.id && ['active', 'paused'].includes(session.status)) {
          const { rows: specs } = await pool.query('SELECT spec_md FROM chat_sessions WHERE id = $1', [session.id]);
          detail.spec_md = specs[0]?.spec_md || null;
        }
        if (detail.source === 'cli_handoff') {
          const { rows: handoffs } = await pool.query(`SELECT handoff_head_sha, handoff_uploaded_sha, handoff_upload_checked_sha, handoff_base_sha FROM chat_sessions WHERE id = $1`, [session.id]);
          const proposal = require('./proposal-handoff').publicSessionStatus({ ...detail, ...handoffs[0] });
          detail.proposal_state = proposal.revisionState || proposal.state;
        }
        detail.shots = config.shots?.present
          ? await require('../services/shots-view')
            .getForSession(pool, detail, detail.app_slug)
          : null;
      }
      // `?results=failing`: the change page's own read, which lists passing
      // checks only when their fold is opened (services/list-test-results.js).
      res.set('Cache-Control', 'no-store').json({ session: listTestResults.forItem(req, detail) });
    } catch (err) {
      log.error('sessions', 'Failed to read check results', { message: err.message });
      res.status(500).json({ error: 'Could not load check results' });
    }
  });

  // Get session with message history
  //
  // Owner OR admin, the same rule `/api/sessions/:id/events` states a few
  // hundred lines down ("Admins should see everything … but regular users
  // only their own"): this route was the one place in the file still
  // matching on `cs.user_id` alone, and the app-level `sessionCollabGuard`
  // above already ran, so widening it grants an admin nothing they cannot
  // already read from that session's event stream. Read-only, so plain
  // `isAdmin` is the gate — a view-only admin qualifies.
  //
  // Concretely this is what made a fifth of the declared proposal checks
  // fail: the check suite signs as `usernode-capture-admin` (a view-only
  // admin), every staging chat_sessions fixture is owned by the FIRST
  // admin instead, and each deep link into one 404'd — a console error on
  // the route, which fails the check whatever it was asserting.
  router.get('/api/sessions/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count,
                -- #1258: the upstream commit this proposal's branch started
                -- from. It is not a column on the session — it lives on the
                -- job that produced the branch — and a coding agent that
                -- arrives on a branch somebody else cut has no other way to
                -- learn it. Without it, a wrong base is caught at submit_work
                -- as base_mismatch, after the change is written.
                --
                -- Two producers, in preference order: the connector's
                -- external_agent_tasks row, then the guided hand-off's own
                -- column. Earliest task wins — a proposal revised through a
                -- second task is still diffed against the base its branch was
                -- originally cut from, which is the number the group votes on.
                --
                -- external_agent_tasks is staging:private, so this reads NULL
                -- on a staging clone. That is the honest answer there, and the
                -- connector reports it as null rather than guessing.
                COALESCE(
                  (SELECT t.base_sha FROM external_agent_tasks t
                    WHERE t.session_id = cs.id
                    ORDER BY t.created_at, t.id
                    LIMIT 1),
                  cs.handoff_base_sha
                ) AS base_sha
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND (cs.user_id = $2 OR $3::boolean)`,
        [req.params.id, req.user.id, !!req.user?.isAdmin]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });

      // #1196: whether this caller can push the proposal's head is not a
      // property of the row on its own. For a head that lives in somebody's
      // fork it is the comparison services/proposal-update.js's
      // `advanceForkHead` makes when a revision arrives — that fork's owner
      // against the GitHub account linked to the CALLER's profile — so the
      // login is carried here and readers report what submit_work will
      // actually do instead of approximating it. Imported rows only: a native
      // proposal's head is a branch in the app repository by definition, and
      // nobody can push that.
      if (rows[0].source === 'imported') {
        const link = await require('../services/github-link').linkStatus(pool, req.user.id);
        rows[0].viewer_github_login = link && link.linked ? link.login : null;
      }

      // #405: the session view's merge-lifecycle pill needs the vote tally to
      // resolve the In-vote / "Passed — merging shortly" states exactly as
      // the proposal feed card does. yes_count/no_count come from the query
      // above; majority is the app's live active-user threshold. Best-effort
      // — a stats hiccup just leaves the pill on the tally-free states.
      try {
        const stats = await getActiveUserStats(pool, rows[0].app_id);
        rows[0].majority = stats?.majority || 1;
        rows[0].active_users = stats?.active || 1;
      } catch { rows[0].majority = rows[0].majority || 1; }

      // #695: governance-aware gate fields, mirroring /promoted, so the
      // session header pill resolves In-vote / "Passed — merging shortly"
      // from the QUALIFYING tally (approver votes only under
      // approver_policy='invited') instead of the raw all-voters counts.
      // Raw yes_count/no_count stay in the payload — the FE derives the
      // advisory (non-approver) surplus as raw − qualified. Best-effort,
      // same as the stats block above.
      if (['promoted', 'merging', 'merged'].includes(rows[0].status)) {
        try {
          const governanceSvc = require('../services/governance');
          const gov = await governanceSvc.getGovernance(pool, rows[0].app_id);
          const electorate = await governanceSvc.getElectorate(pool, rows[0].app_id, gov);
          const q = electorate.approverIds
            ? await governanceSvc.qualifiedCounts(
              pool, 'pr', rows[0].id, electorate.approverIds,
              reviewedHeadForSession(rows[0])
            )
            : { yes: rows[0].yes_count, no: rows[0].no_count };
          const gate = governanceSvc.computeGate(
            gov, electorate.active, q.yes, q.no, rows[0].promoted_at || rows[0].created_at
          );
          rows[0].votes_required = gate.required;
          rows[0].merge_window_ends_at = gate.windowEndsAt;
          rows[0].approval_policy = gate.policy;
          rows[0].approvals_required = gate.approvalsRequired;
          rows[0].qualified_yes_count = gate.qualifiedYes;
          rows[0].qualified_no_count = gate.qualifiedNo;
        } catch { /* pill falls back to the raw tallies */ }
      }

      // A GET on this route is NOT by itself evidence that the user opened
      // the session. The dev chat refetches it programmatically all the
      // time, and most of those fetches happen at the exact moment a turn
      // ends: the fallback-done reconcile (#465), the progress poll's
      // !busy branch, the sync-terminal refresh, the vote/version pill
      // refresh. Since #138 creates a session_done notification on EVERY
      // turn completion, the completion was being marked read by the
      // reconcile fetch ~200ms after it was written — so the cog's green
      // badge painted and vanished within one frame, i.e. never appeared.
      //
      // The two attention-scoped side effects below therefore need the
      // caller to SAY that a person opened the session: `?opened=1`, set
      // only by DevChat.openSession's user-initiated call sites (session
      // row / active-chip click, hash restore, post-flow reopen). Machine
      // refetches omit it and are now side-effect free apart from the
      // activity bump.
      const userOpened = req.query.opened === '1';

      // Viewing a session counts as activity so the auto-pause sweeper
      // doesn't pause a session the user is actively reading. Fire-and-
      // forget — the view shouldn't block on this write, and a missed
      // bump just means the next chat turn / open re-marks it. This one
      // stays on every fetch: a session being polled by its owner's open
      // tab is in use, and gating it on ?opened=1 would let a long turn
      // look idle to the sweeper. A user open ALSO disarms notify_on_done
      // (#161): the owner is looking at the session again, so a
      // left-mid-turn completion needs no notification.
      //
      // OWNER ONLY. Both of those are statements about the owner's
      // attention, and neither is true when the admin read above is what
      // resolved this row: an admin (or the check suite) glancing at a
      // session must not keep it awake, and must certainly not cancel the
      // owner's "tell me when it's done" notification.
      if (rows[0].user_id === req.user.id) {
        pool.query(
          `UPDATE chat_sessions SET last_activity_at = NOW()${userOpened ? ', notify_on_done = FALSE' : ''} WHERE id = $1`,
          [req.params.id]
        ).catch((err) => log.warn('sessions', 'activity bump on view failed', { err: err.message }));
      }

      // #161 auto-dismiss: a user opening the session is the canonical
      // "user saw it" signal — resolve any unread session_done rows for
      // it, even when the user navigated here on their own rather than via
      // the notification. Fire-and-forget; cross-tab badge sync on change.
      if (userOpened) {
        notifications.markReadForAction(pool, req.user.id, 'session_opened', rows[0].id)
          .then((cleared) => {
            if (cleared > 0) {
              const { pushNotificationToUser } = require('../services/ws');
              pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
            }
          })
          .catch((err) => log.warn('sessions', 'session_opened dismiss failed', { err: err.message }));
      }

      const { rows: messages } = await pool.query(
        `SELECT id, role, content, model, token_count, cost_cents, metadata, created_at
         FROM chat_session_messages
         WHERE session_id = $1
         ORDER BY id ASC`,
        [req.params.id]
      );

      // #195: attach the session's stored before/after capture ids so the
      // staging card can render its visual tiles on history reload (the
      // live path delivers the same shape via the visuals_ready event).
      // Best-effort — a visuals hiccup must not break opening the session.
      const session = rows[0];
      // #1650: a managed local handoff cannot be proposed merely because it
      // is active. Its exact submitted head must have live staging and a
      // terminal passing verdict, and the in-memory build/check/capture gates
      // matter too. Publish the SAME state the CLI status endpoint and
      // promotion preflight compute so the Changes ready card can disable its
      // action before a doomed request. Ordinary Dev sessions deliberately do
      // not get this field: their promote path may still build on demand.
      if (session.source === 'cli_handoff') {
        const proposal = require('./proposal-handoff').publicSessionStatus(session);
        session.proposal_state = proposal.revisionState || proposal.state;
      }
      try {
        session.visuals = await visuals.getForSession(
          pool, session.id, visualHeadForSession(session)
        );
      } catch { session.visuals = null; }
      try {
        session.shots = config.shots?.present
          ? await require('../services/shots-view')
            .getForSession(pool, session, session.app_slug)
          : null;
      } catch { session.shots = null; }

      // #940: the session's saved drafts ride along so opening a session
      // needs no second round trip on the hot path. Best-effort: `null`
      // means "unknown", which the client reads as "keep the local mirror
      // and reconcile later" — a drafts hiccup must never break opening a
      // session. The query is owner-scoped by construction (this whole
      // handler already resolved the session as req.user's).
      let drafts = null;
      try {
        drafts = await listDrafts(pool, session.id);
      } catch (err) {
        log.warn('sessions', 'drafts load failed', { sessionId: session.id, err: err.message });
      }

      // #1442: opening a promoted proposal is the one moment its freshness
      // numbers are about to be READ by a person deciding how to vote, so
      // this is where they are worth re-measuring. TTL-gated (60s) and
      // single-flighted per session in the service, so the dev chat's
      // frequent machine refetches and several voters opening the same
      // proposal at once still cost at most one pair of GitHub calls a
      // minute. Never throws, and the refreshed block is folded onto the row
      // that is about to be serialized so the response carries the number it
      // just measured rather than the one it read a moment earlier.
      if (session.status === 'promoted' && session.repo_url) {
        try {
          const freshnessSvc = require('../services/proposal-freshness');
          const written = await freshnessSvc.refreshFreshnessDeduped(
            { gh: require('../services/github'), pool }, session
          );
          if (written && !written.skipped) {
            session.freshness_checked_at = written.checkedAt;
            session.freshness_main_sha = written.mainSha;
            session.freshness_merge_base_sha = written.mergeBaseSha;
            session.freshness_behind_by = written.behindBy;
            session.freshness_ahead_by = written.aheadBy;
            session.mergeability = written.mergeability;
            session.mergeability_files = written.mergeabilityFiles;
            session.mergeability_files_complete = written.mergeabilityFilesComplete;
            session.checks_base_verdict = written.checksBaseVerdict;
            session.checks_base_behind_by = written.checksBaseBehindBy;
            session.freshness_error = written.error;
            if (written.behindBy != null) session.behind_main = Math.max(0, written.behindBy);
          }
        } catch (err) {
          log.warn('sessions', 'freshness refresh failed', { sessionId: session.id, err: err.message });
        }
      }
      session.freshness = require('../services/proposal-freshness').readFreshness(session);

      res.json({ session, messages, drafts });
    } catch (err) {
      log.error('sessions', 'Failed to get session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/activity
  //   Lightweight heartbeat from the dev-chat UI. While the user has a
  //   session open and the tab visible, the client pings this so
  //   last_activity_at stays fresh — that's what lets the auto-pause
  //   timer run on a short (~5 min) worker-eviction-aligned window
  //   without pausing sessions someone is actively reading. One indexed
  //   UPDATE; only bumps 'active'/'promoted' rows owned by the caller.
  router.post('/api/sessions/:id/activity', async (req, res) => {
    try {
      await pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'promoted')`,
        [req.params.id, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      // Best-effort — a failed heartbeat just risks an earlier auto-pause,
      // which is recoverable (reopening auto-resumes). Don't 500-spam.
      res.json({ ok: false });
    }
  });

  // #161: arm/disarm the "notify me when this turn finishes" flag.
  // Owner-only. The client arms it the moment the owner stops watching a
  // running turn (tab hidden, window blurred, tab/app switch, pagehide
  // beacon) and disarms it when they come back mid-run. Idempotent
  // (plain SET), so duplicate fires — e.g. a pagehide beacon racing an
  // earlier visibility-arm — are harmless. Accepts navigator.sendBeacon
  // payloads: a same-origin JSON Blob rides through express.json() and
  // cookie auth applies as usual.
  router.post('/api/sessions/:id/notify-on-done', async (req, res) => {
    try {
      const armed = !!(req.body && req.body.armed);
      const { rowCount } = await pool.query(
        `UPDATE chat_sessions SET notify_on_done = $1
         WHERE id = $2 AND user_id = $3`,
        [armed, req.params.id, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Session not found' });
      res.status(204).end();
    } catch (err) {
      log.error('sessions', 'notify-on-done update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Issue-report draft confirm / dismiss (human gate) ────────────────
  //
  // A draft reaches this timeline two ways: the build-turn agent's
  // usernode-report-platform-issue CLI (see src/routes/internal.js POST
  // /api/internal/sessions/:id/platform-issue) and, since #1037, the
  // Mayor's in-process draft_issue_report tool when the user asks for an
  // issue to be created. Both go through services/issue-draft.js and land
  // as the same metadata.platformIssueDraft row. Nothing reaches GitHub
  // until a user taps confirm on the card — that tap lands here. Dismiss
  // marks the draft dead without filing. Both are one-shot: the draft's
  // status gates them, and confirm claims the row atomically so two
  // concurrent taps can't double-file.
  //
  // #1037: a draft carries `target` ('platform' | 'app'). Platform files
  // with the bot PAT against config.platformRepoUrl (the platform repo
  // isn't behind the per-app GitHub App installation); app files through
  // the installation against the app's own repo, matching the app path in
  // routes/feedback.js. A draft with no `target` predates this and is
  // platform, so old rows behave exactly as before.
  //
  // Access: the sessionCollabGuard above already restricts these to
  // collab-level members of the session's app — the same audience that
  // can see the card at all.
  const platformIssueDraftAction = async (req, res, action) => {
    const sessionId = parseInt(req.params.id, 10);
    const msgId = parseInt(req.params.msgId, 10);
    if (!Number.isFinite(sessionId) || !Number.isFinite(msgId)) {
      return res.status(400).json({ error: 'Bad id' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT m.id, m.metadata, cs.app_id,
                a.slug AS app_slug, a.name AS app_name, a.repo_url AS app_repo_url
           FROM chat_session_messages m
           JOIN chat_sessions cs ON cs.id = m.session_id
           JOIN apps a ON a.id = cs.app_id
          WHERE m.id = $1 AND m.session_id = $2`,
        [msgId, sessionId]
      );
      const row = rows[0];
      const draft = row?.metadata?.platformIssueDraft;
      if (!draft) return res.status(404).json({ error: 'Draft not found' });
      if (draft.status !== 'pending') {
        return res.status(409).json({
          error: 'Already resolved',
          status: draft.status,
          ...(draft.issueUrl ? { url: draft.issueUrl, number: draft.issueNumber } : {}),
        });
      }

      if (action === 'dismiss') {
        await pool.query(
          `UPDATE chat_session_messages
              SET metadata = jsonb_set(metadata, '{platformIssueDraft,status}', '"dismissed"')
            WHERE id = $1 AND session_id = $2
              AND metadata->'platformIssueDraft'->>'status' = 'pending'`,
          [msgId, sessionId]
        );
        return res.json({ ok: true, status: 'dismissed' });
      }

      // Confirm: claim the draft atomically BEFORE filing so a concurrent
      // confirm can't double-file; revert to pending if GitHub fails.
      const claim = await pool.query(
        `UPDATE chat_session_messages
            SET metadata = jsonb_set(metadata, '{platformIssueDraft,status}', '"filed"')
          WHERE id = $1 AND session_id = $2
            AND metadata->'platformIssueDraft'->>'status' = 'pending'`,
        [msgId, sessionId]
      );
      if (!claim.rowCount) return res.status(409).json({ error: 'Already resolved' });

      const revert = () => pool.query(
        `UPDATE chat_session_messages
            SET metadata = jsonb_set(metadata, '{platformIssueDraft,status}', '"pending"')
          WHERE id = $1 AND session_id = $2`,
        [msgId, sessionId]
      ).catch(() => {});

      // Destination. The draft stamped owner/repo at draft time so the
      // card can't file somewhere other than what it displayed; fall back
      // to resolving from config for drafts written before #1037.
      const isAppTarget = draft.target === 'app';
      const stamped = draft.owner && draft.repo
        ? { owner: draft.owner, repo: draft.repo }
        : issueDraft.parseRepoUrl(isAppTarget ? row.app_repo_url : config.platformRepoUrl);
      const pat = process.env.GITHUB_BOT_TOKEN;
      if (!stamped || (!isAppTarget && !pat) || (isAppTarget && !github.isEnabled())) {
        await revert();
        return res.status(503).json({ error: 'Issue reporting not configured' });
      }
      const { owner, repo } = stamped;

      // #723: backtick-wrapped username (never `@name` — platform usernames
      // are unrelated to GitHub handles, and a mention pings a stranger).
      const sourceLine =
        `**Source:** usernode agent (session ${sessionId}, confirmed by \`${req.user.username}\`)\n`;
      const issueBody = isAppTarget
        // App target mirrors the app branch of routes/feedback.js: the
        // issue lands in the app's own tracker, so name the app rather
        // than "reported while working on".
        ? `${sourceLine}**App:** ${row.app_name} (${row.app_slug})\n\n`
          + (draft.body || '(no detail provided)')
        : `${sourceLine}**Reported while working on:** ${row.app_name} (${row.app_slug})\n\n`
          + (draft.body || '(no detail provided)');
      let issue;
      try {
        if (isAppTarget) {
          // The app's own repo is reached through the GitHub App
          // installation (same path as routes/feedback.js and
          // routes/issues.js) — the platform PAT isn't guaranteed to have
          // access to every app repo. createIssue applies safeMention
          // internally.
          issue = await github.createIssue(owner, repo, {
            title: draft.title,
            body: issueBody,
          });
        } else {
          // Bot PAT + hand-rolled fetch mirrors routes/feedback.js's
          // platform-feedback path (the platform repo isn't behind the
          // per-app GitHub App installation). This bypasses github.js's
          // write helpers, so apply safeMention here — the model-drafted
          // title/body are free-form text that could carry live
          // @mentions (#723).
          const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `token ${pat}`,
              'User-Agent': 'usernode-social-vibecoding',
            },
            body: JSON.stringify({
              title: github.safeMention(draft.title),
              body: github.safeMention(issueBody),
              labels: ['usernode', 'agent-reported'],
            }),
          });
          if (!ghRes.ok) {
            const text = await ghRes.text();
            log.error('sessions', 'Platform issue create failed', {
              sessionId, msgId, status: ghRes.status, body: text.slice(0, 300),
            });
            await revert();
            return res.status(502).json({ error: 'GitHub refused the issue' });
          }
          issue = await ghRes.json();
        }
      } catch (err) {
        log.error('sessions', 'Issue create threw', {
          sessionId, msgId, target: draft.target || 'platform', err: err.message,
        });
        await revert();
        return res.status(502).json({
          error: isAppTarget
            // Never silently reroute to the platform repo — the card said
            // where it would file. Surface the actionable hint instead.
            ? "Couldn't file to this app's repo. The bot may not be installed on it"
            : 'GitHub unreachable',
        });
      }

      await pool.query(
        `UPDATE chat_session_messages
            SET metadata = jsonb_set(metadata, '{platformIssueDraft}',
                  (metadata->'platformIssueDraft')
                  || jsonb_build_object(
                       'issueNumber', $3::int,
                       'issueUrl', $4::text,
                       'confirmedBy', $5::text))
          WHERE id = $1 AND session_id = $2`,
        [msgId, sessionId, issue.number, issue.html_url, req.user.username]
      ).catch((err) => log.warn('sessions', 'Platform-issue metadata enrich failed', {
        msgId, err: err.message,
      }));

      // #125/#192: seed the open-issues cache + created overlay and
      // broadcast issue_update, so the new issue appears in the app's
      // "Open Issues" panel (and every agent-facing issue listing)
      // immediately instead of waiting out the fetchPublicIssues TTL.
      // Best-effort by contract — the issue is already filed. An
      // app-target issue passes the app context so the right panel
      // refreshes; the platform target resolves its app row by repo
      // (no-op when none matches), exactly as before.
      await issueAnnounce.announceIssueCreated(pool, owner, repo, issue, isAppTarget
        ? { id: row.app_id, slug: row.app_slug, name: row.app_name }
        : null);

      log.info('sessions', 'Issue filed after user confirm', {
        sessionId, msgId, number: issue.number, user: req.user.username,
        target: draft.target || 'platform',
      });
      return res.json({ ok: true, status: 'filed', number: issue.number, url: issue.html_url });
    } catch (err) {
      log.error('sessions', 'Platform-issue draft action failed', {
        sessionId, msgId, action, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };

  router.post('/api/sessions/:id/platform-issue/:msgId/confirm', (req, res) =>
    platformIssueDraftAction(req, res, 'confirm'));
  router.post('/api/sessions/:id/platform-issue/:msgId/dismiss', (req, res) =>
    platformIssueDraftAction(req, res, 'dismiss'));

  // Archive a session. Reversible: tears down staging + worker and closes
  // the PR, but KEEPS the CC volume + branch so /unarchive can restore it
  // within the retention window (a background GC purges the volume only
  // after ARCHIVED_RETENTION_MS). Use the service so the stale-PR sweeper
  // archives the exact same way.
  router.post('/api/sessions/:id/archive', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Archiving a declaration proposal discards its held encrypted value.
      // Look up only the caller's own row so this check creates no session-id
      // oracle; the lifecycle service retains its authoritative owner check.
      if (req.cliAuthenticated) {
        const { rows } = await pool.query(
          'SELECT branch_name FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [sessionId, req.user.id]
        );
        if (isCliCredentialManagementSession(req, rows[0])) {
          return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
        }
      }

      // Release any in-flight bookkeeping first (archiving mid-turn).
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }

      const { archived } = await sessionLifecycle.archiveSession({
        pool, sessionId, userId: req.user.id, reason: 'manual',
      });
      if (!archived) return res.status(404).json({ error: 'Session not found or already archived' });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Archive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/unpromote (#3114)
  //   Move the caller's own proposal from "In review" back to "Underway"
  //   without closing its pull request: votes are voided, the merge path can
  //   no longer claim it, and a later promote puts it up for a fresh vote.
  //   Owner-scoped like /archive. All the safety lives in
  //   sessionLifecycle.unpromoteSession's single guarded UPDATE.
  router.post('/api/sessions/:id/unpromote', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!Number.isInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ error: 'Bad session id' });
      }
      const result = await sessionLifecycle.unpromoteSession({
        pool, sessionId, userId: req.user.id, actorUsername: req.user.username,
      });
      if (result.ok) {
        return res.json({ ok: true, status: result.status, ...(result.already ? { alreadyUnderway: true } : {}) });
      }
      switch (result.code) {
        case 'not_found':
          return res.status(404).json({ error: 'Proposal not found' });
        case 'forbidden':
          return res.status(403).json({ error: 'Only the proposer can move this proposal back to Underway' });
        case 'merging':
          return res.status(409).json({ error: 'This proposal is already merging, so it can no longer be moved back to Underway.' });
        case 'busy':
          return res.status(409).json({ error: 'A build is running on this change. Wait for it to finish, then move it back to Underway.' });
        case 'pending_secret':
          return res.status(409).json({ error: 'This proposal holds a secret value that is discarded when it leaves review. Withdraw it instead if you want to stop it.' });
        default:
          return res.status(409).json({ error: 'This proposal is no longer in review.' });
      }
    } catch (err) {
      log.error('sessions', 'Unpromote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/reset-agent-context
  //   Switch a session's coding-agent backend/model (plan.md §11.3).
  //   Keeps the Git branch + working tree but starts a fresh agent
  //   thread: clears agent_thread_id, bumps agent_config_version, evicts
  //   the warm worker. Only allowed on an idle, owned, non-archived
  //   session. For codex_openrouter the caller must have a valid
  //   OpenRouter credential.
  router.post('/api/sessions/:id/reset-agent-context', drainGuard, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { backend, model, reasoningEffort } = req.body || {};
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ error: 'Bad session id' });
      }

      // ── Phase 1: validate network-dependent inputs BEFORE locking ──
      // (plan 8.1). Backend resolution, feature/allowlist checks, and the
      // OpenRouter credential + model validation can call out over the
      // network (or decrypt); they must NOT run while holding a row lock.
      //
      // NO `backend` KEY MEANS "whichever on-platform agent I used last"
      // (#1348). The venue sheet asks a coarse question now — one
      // "On-Platform" row standing for both in-chat backends — so it sends
      // no backend and the answer is resolved here, from the user's stored
      // preference, exactly as creating a session does. Omitted, not
      // nulled: a literal null is a value, and the same distinction POST
      // /sessions already draws.
      //
      // The two resolvers are not interchangeable and the difference is the
      // point. An EXPLICIT pick must get that backend or an error explaining
      // why not. A stored default falls back only for deliberate deployment
      // policy (flag off / beta access gone). Missing credentials trigger
      // managed provisioning; provisioning or catalog failures stop here and
      // remain visible rather than silently moving the session to Claude.
      const wantsStoredDefault = backend == null;
      let pref;
      try {
        pref = wantsStoredDefault
          ? await resolveDefaultAgentPreference(pool, req.user.id, config)
          : await resolveExplicitAgentPreference(pool, req.user.id, config, {
            backend,
            model,
            reasoningEffort,
          });
      } catch (err) {
        if (err instanceof AgentSelectionError) {
          return res.status(err.statusCode).json(agentSelectionErrorBody(err));
        }
        throw err;
      }
      const resolved = pref.backend;
      const isCodex = resolved === 'codex_openrouter';

      // ── Phases 2-5: the switch itself ──
      // Shared with an agent session's dispatch, which applies the
      // conversation's model choice to its active change the same way
      // (switchSessionAgent, below the resolvers).
      const switched = await switchSessionAgent(pool, {
        sessionId, userId: req.user.id, pref,
      });
      if (!switched.ok) {
        return res.status(switched.status).json({ error: switched.error });
      }
      const updatedRow = switched.session;
      const contextMessage = switched.message;

      // #1348: an EXPLICIT pick is also the answer to "which one did you
      // use last", so it is remembered. This is the rule the venue sheet
      // already applies to the other group — picking a web hand-off saves
      // dev_flow_preference, because "asked once" means the answer counts
      // for next time — extended to the in-chat pair now that one coarse
      // row stands for both.
      //
      // AFTER the commit and best-effort: the switch has already happened,
      // and a preference that failed to save must not turn a successful
      // switch into a 500. A resolved switch writes nothing — it was read
      // FROM the preference and has no new answer to record.
      if (!wantsStoredDefault) {
        try {
          await agentPreferences.setDefaultBackend(pool, req.user.id, {
            backend: pref.backend,
            model: pref.model,
            reasoningEffort: pref.reasoningEffort,
          });
        } catch (prefErr) {
          log.warn('sessions', 'reset-agent-context: default not remembered', {
            sessionId, userId: req.user.id, err: prefErr.message,
          });
        }
      }

      res.json({
        ok: true,
        session: updatedRow,
        message: contextMessage,
        // Present only when a stored OpenRouter preference could not be
        // honoured. The client turns it into the sentence above the
        // composer — the same surface a new session's fallback uses.
        ...(pref.fallbackReason ? { agentFallbackReason: pref.fallbackReason } : {}),
      });
    } catch (err) {
      log.error('sessions', 'reset-agent-context failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/build-venue
  //   Persist WHERE this session is being built (#1281).
  //
  //   The six venue ids were a presentation key until now — #1086 said so
  //   deliberately, because every venue was already expressible through a
  //   column that existed. #1281 asks for the one state none of them can
  //   express: a session whose owner has decided to hand the work to Claude
  //   Code, Codex or their own tools and has NOT done it yet. That decision
  //   is what the launchpad renders from, and `external_agent` cannot serve
  //   it — that column is stamped at submission, so it is null for exactly
  //   the period the launchpad is on screen. See chat_sessions.build_venue
  //   in schema.sql.
  //
  //   Deliberately NOT part of reset-agent-context: that route switches the
  //   in-chat backend and, by design, throws away the agent thread and
  //   evicts the warm worker. Choosing to build somewhere else must do
  //   neither — the transcript, the branch and the proposal all stay exactly
  //   as they are, which is the promise the venue sheet makes when it says
  //   an in-chat venue "keeps this chat, this branch and this proposal".
  router.post('/api/sessions/:id/build-venue', drainGuard, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (!Number.isFinite(sessionId)) {
        return res.status(400).json({ error: 'Bad session id' });
      }
      const venue = typeof (req.body || {}).venue === 'string' ? req.body.venue : null;
      // Clearing is legitimate: it returns the session to "nobody has
      // chosen", where BuildVenues.currentVenue() derives from the columns
      // exactly as it did before this route existed.
      if (venue !== null && !BUILD_VENUES.includes(venue)) {
        return res.status(400).json({ error: 'Unknown build venue' });
      }
      const { rows } = await pool.query(
        `UPDATE chat_sessions
            SET build_venue = $3
          WHERE id = $1 AND user_id = $2
            AND status NOT IN ('archived', 'merged')
        RETURNING *`,
        [sessionId, req.user.id, venue],
      );
      const updated = rows[0];
      if (!updated) {
        // Either it is not theirs, or it is closed. Both are a 404 here for
        // the same reason the archive routes make them one: an owner who
        // cannot see the session must not learn it exists.
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ ok: true, session: updated });
    } catch (err) {
      log.error('sessions', 'build-venue failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/unarchive
  //   Reverse an archive (within the retention window). Restores the
  //   session to 'paused' and best-effort reopens the PR; reopening it in
  //   the UI then auto-resumes via the normal path. If the CC volume was
  //   already GC'd (cc_purged), the restore still works but Claude starts
  //   fresh — we surface that so the UI can warn.
  router.post('/api/sessions/:id/unarchive', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      if (req.cliAuthenticated) {
        const { rows } = await pool.query(
          'SELECT branch_name FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [sessionId, req.user.id]
        );
        if (isCliCredentialManagementSession(req, rows[0])) {
          return res.status(403).json({ error: CLI_CREDENTIAL_MANAGEMENT_ERROR });
        }
      }
      const { unarchived, ccPurged, prReopened } = await sessionLifecycle.unarchiveSession({
        pool, sessionId, userId: req.user.id,
      });
      if (!unarchived) return res.status(404).json({ error: 'Session not found or not archived' });
      res.json({ ok: true, ccPurged: !!ccPurged, prReopened: !!prReopened });
    } catch (err) {
      log.error('sessions', 'Unarchive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/share | /unshare
  //   Toggle a session's "visible to everyone" flag (chat_sessions.
  //   shared_at — see schema.sql). Owner-scoped like archive/unarchive;
  //   headless rows excluded. Allowed on active/paused/promoted rows
  //   (promoted is a display no-op — the proposal card already shows —
  //   but keeps the flag for a later un-promote). Share is idempotent
  //   and keeps the ORIGINAL shared_at (COALESCE) so re-sharing doesn't
  //   jump the card to the bottom of other users' In progress area.
  //   Both broadcast a session_update so open Dev boards refresh live.
  //
  //   `{ transcript: true }` in the body ALSO publishes the transcript in
  //   the same write (the "make it visible and readable in one go" path).
  //   Omitting it — every pre-existing caller — leaves
  //   transcript_shared_at untouched, so today's behaviour is unchanged
  //   byte for byte: making a session visible never publishes the chat by
  //   accident.
  router.post('/api/sessions/:id/share', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const withTranscript = !!(req.body && req.body.transcript);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs
            SET shared_at = COALESCE(cs.shared_at, NOW()),
                transcript_shared_at = CASE WHEN $3::boolean
                  THEN COALESCE(cs.transcript_shared_at, NOW())
                  ELSE cs.transcript_shared_at END
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND cs.status IN ('active', 'paused', 'promoted')
            AND a.id = cs.app_id
          RETURNING cs.id, cs.shared_at, cs.transcript_shared_at,
                    a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id, withTranscript]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'shared', sessionId, appId: rows[0].app_id, appSlug: rows[0].app_slug });
      res.json({
        ok: true,
        shared_at: rows[0].shared_at,
        transcript_shared_at: rows[0].transcript_shared_at,
      });
    } catch (err) {
      log.error('sessions', 'Share failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unshare clears BOTH stamps. Making a session private again must never
  // leave the transcript readable behind a card nobody can see any more —
  // the reader could still hold (or bookmark) the session id.
  router.post('/api/sessions/:id/unshare', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs SET shared_at = NULL, transcript_shared_at = NULL
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND a.id = cs.app_id
          RETURNING cs.id, a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'unshared', sessionId, appId: rows[0].app_id, appSlug: rows[0].app_slug });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Unshare failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/share-transcript | /unshare-transcript
  //   The SECOND, narrower opt-in: publish the dev-chat TRANSCRIPT so
  //   anyone with view access can read it (and fork it). Owner-scoped and
  //   headless-excluded exactly like /share.
  //
  //   share-transcript sets shared_at too — publishing the chat implies
  //   board visibility, so the reader has a card to reach it from and the
  //   two flags can never disagree in the "readable but invisible"
  //   direction. Both stamps use COALESCE so re-sharing is idempotent and
  //   doesn't reshuffle the board's oldest-shared-first ordering.
  router.post('/api/sessions/:id/share-transcript', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs
            SET shared_at = COALESCE(cs.shared_at, NOW()),
                transcript_shared_at = COALESCE(cs.transcript_shared_at, NOW())
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND cs.status IN ('active', 'paused', 'promoted')
            AND a.id = cs.app_id
          RETURNING cs.id, cs.shared_at, cs.transcript_shared_at,
                    a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({
        action: 'transcript_shared', sessionId,
        appId: rows[0].app_id, appSlug: rows[0].app_slug,
      });
      res.json({
        ok: true,
        shared_at: rows[0].shared_at,
        transcript_shared_at: rows[0].transcript_shared_at,
      });
    } catch (err) {
      log.error('sessions', 'Share transcript failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Revokes transcript reading only — the session stays on everyone's
  // board with its discussion thread intact. Deliberately NOT
  // status-filtered: revoking must work on any row whose flag is set,
  // including one that has since been promoted or archived.
  router.post('/api/sessions/:id/unshare-transcript', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `UPDATE chat_sessions cs SET transcript_shared_at = NULL
           FROM apps a
          WHERE cs.id = $1 AND cs.user_id = $2 AND cs.is_headless = FALSE
            AND a.id = cs.app_id
          RETURNING cs.id, cs.shared_at, a.id AS app_id, a.slug AS app_slug`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({
        action: 'transcript_unshared', sessionId,
        appId: rows[0].app_id, appSlug: rows[0].app_slug,
      });
      res.json({ ok: true, shared_at: rows[0].shared_at, transcript_shared_at: null });
    } catch (err) {
      log.error('sessions', 'Unshare transcript failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/sessions/:id/transcript
  //   The read-only surface: a shared session's conversation, sanitised.
  //   View-gated by the sessionCollabGuard at the top of this router (GET →
  //   'view'), so read-only app viewers may read a published transcript
  //   while writes below stay collab-gated.
  //
  //   Deliberately a SEPARATE route from GET /api/sessions/:id rather than a
  //   relaxation of it: that one auto-resumes paused sessions, bumps
  //   last_activity_at and clears the owner's notifications. A reader must
  //   trigger none of those side effects, so this handler only ever SELECTs.
  //
  //   Authorization: both stamps non-NULL and non-headless, OR the caller is
  //   the owner (who gets the identical sanitised payload — that's the
  //   "preview what everyone else sees" path, and keeping it identical means
  //   there is no second, laxer code path to get wrong). 404 on deny, never
  //   403, matching the guard's non-enumerable posture.
  //
  //   NOT status-filtered: shared_at survives promotion and merge in
  //   production, and the proposal page reuses this exact route.
  router.get('/api/sessions/:id/transcript', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Staging-only demo rows (?demo=1): the 99xxxx shared-session ids the
      // demo branch of GET /shared-sessions injects don't exist in the DB, so
      // serve a mock transcript for them instead of a 404 — same convention
      // as stagingMockIssueComments. Strict no-op in production.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        const mock = stagingMockTranscript(sessionId);
        if (mock) return res.json(mock);
      }

      const { rows } = await pool.query(
        `SELECT cs.id, cs.session_title, cs.pr_title, cs.branch_name, cs.status,
                cs.user_id, COALESCE(u.username, 'Deleted user') AS username, cs.shared_at, cs.transcript_shared_at,
                cs.created_at,
                (SELECT COUNT(*)::int FROM chat_session_messages m
                  WHERE m.session_id = cs.id) AS message_count
           FROM chat_sessions cs
           LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1
            AND cs.is_headless = FALSE
            AND (cs.user_id = $2
                 OR (cs.shared_at IS NOT NULL AND cs.transcript_shared_at IS NOT NULL))`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Transcript not available' });
      const row = rows[0];
      const isOwner = row.user_id === req.user.id;

      // Most recent N by id, then flipped back to oldest-first for render, so
      // truncation drops the START of a very long chat rather than its
      // conclusion (the useful end).
      const { rows: raw } = await pool.query(
        `SELECT id, role, content, model, metadata, created_at
           FROM chat_session_messages
          WHERE session_id = $1
          ORDER BY id DESC
          LIMIT $2`,
        [sessionId, transcriptShare.MAX_TRANSCRIPT_MESSAGES + 1]
      );
      const truncated = raw.length > transcriptShare.MAX_TRANSCRIPT_MESSAGES;
      const newestFirst = truncated
        ? raw.slice(0, transcriptShare.MAX_TRANSCRIPT_MESSAGES)
        : raw;
      const messages = transcriptShare.sanitizeTranscript(newestFirst.slice().reverse());

      res.json({
        session: {
          id: row.id,
          session_title: row.session_title,
          pr_title: row.pr_title,
          branch_name: row.branch_name,
          status: row.status,
          username: row.username,
          transcript_shared_at: row.transcript_shared_at,
          message_count: row.message_count,
          is_owner: isOwner,
          // "Fork this chat" is retired with classic sessions (#2779).
          // Still reported, as false, so a shell cached before that does
          // not draw a button whose POST now answers 410.
          can_fork: false,
        },
        messages,
        truncated,
      });
    } catch (err) {
      log.error('sessions', 'Transcript read failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/fork
  //   Forked a shared, transcript-published dev chat into a new classic
  //   session of the caller's. Retired with classic sessions (#2779): new
  //   work starts in an agent session, and a shell cached before the switch
  //   is told so rather than getting a 404. The transcript read above
  //   reports can_fork false, so no current page offers it.
  router.post('/api/sessions/:id/fork', (req, res) => {
    res.status(410).json({ error: CLASSIC_SESSIONS_RETIRED, code: 'agent_sessions_only' });
  });

  // POST /api/sessions/:id/pause
  //   Reversible counterpart to /archive. The point is to free the
  //   3-active-session slot without throwing away anything the user
  //   would want back on /resume:
  //     - Worker container: destroyed (frees the slot).
  //     - Staging container: torn down (cheap to recreate from the
  //       branch on resume).
  //     - CC session volume: PRESERVED. This is the bit that lets
  //       --resume <cc_session_id> still work after a resume.
  //     - PR: LEFT OPEN. Closing+reopening PRs gets messy on GitHub
  //       (auto-closed PRs can only be reopened by the closer; some
  //       installations refuse it entirely), so pause is purely a
  //       worker/container thing as far as GitHub is concerned.
  //     - Branch: untouched.
  //   Idempotent on the status side — re-pausing a paused session is
  //   a no-op rather than an error, since the state we'd land in is
  //   the same.
  router.post('/api/sessions/:id/pause', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Drop in-flight bookkeeping first so pausing mid-turn (the user
      // pausing to abort a running turn) releases the activeWorkers slot.
      // pauseSession() tears down the container + staging itself.
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }

      const { paused } = await sessionLifecycle.pauseSession({
        pool, sessionId, userId: req.user.id, reason: 'manual',
      });
      if (!paused) {
        // Either it doesn't exist, isn't ours, or is already paused/archived,
        // or it's a promoted session (which pauseSession deliberately refuses
        // to demote so its PR stays up for vote).
        const { rows: check } = await pool.query(
          `SELECT id, status FROM chat_sessions WHERE id = $1 AND user_id = $2`,
          [sessionId, req.user.id]
        );
        // Soft 200 if it's already paused so the UI can no-op the button click.
        if (check[0] && check[0].status === 'paused') return res.json({ ok: true, alreadyPaused: true });
        // Promoted: honor the user's intent to free the warm worker (same
        // teardown pauseSession does for 'active'), but leave status =
        // 'promoted' so the PR keeps showing its voting buttons and stays
        // votable. The vote endpoint and cast-vote handler key off the
        // promoted status, so flipping it here would silently pull the PR
        // from the vote — exactly the bug we're fixing.
        if (check[0] && check[0].status === 'promoted') {
          workerProgress.clear(sessionId);
          await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});
          return res.json({ ok: true, keptPromoted: true });
        }
        return res.status(404).json({ error: 'Session not found or cannot be paused' });
      }
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Pause failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/resume
  //   Inverse of /pause. Flips status back to 'active' so the next
  //   chat turn can lazily spawn a worker (CC volume is still on
  //   disk, so --resume <cc_session_id> picks up where we left off).
  //   Also the auto-resume target: the dev-chat UI calls this when a
  //   user opens a paused session.
  //
  //   Cap handling:
  //     - Global cap: refuse if the platform-wide active+promoted count
  //       is already at maxGlobalSessions (a flood of simultaneous
  //       resumes shouldn't blow past the concurrency ceiling).
  //     - Per-user cap: if the user is already at maxUserSessions, the
  //       default (sessionLruOnResume) is to auto-pause their least-
  //       recently-active session to make room, so reopening always
  //       works. Set SESSION_LRU_ON_RESUME=false to keep the old hard
  //       429. If every other session is mid-turn (can't be paused), we
  //       fall back to a 429.
  //   We deliberately do NOT pre-spawn the worker here; first-turn lazy
  //   boot is what every other path uses.
  router.post('/api/sessions/:id/resume', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const resumed = await resumePausedSession({ pool, config, user: req.user, sessionId });
      if (!resumed.ok) return res.status(resumed.status).json({ error: resumed.error });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Resume failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #8: POST /api/sessions/:id/sync-main
  //   Merge origin/main into the session's branch. Runs a worker turn
  //   in MODE=sync (see worker/run-cc.sh). Clean merges are
  //   commit+push only (no CC, no LLM spend); conflicts dispatch CC
  //   with a resolution-only prompt and abort cleanly if CC can't
  //   resolve.
  //
  //   Owner-only. Returns the syncResult so the UI can route messaging:
  //     already_synced — nothing to do
  //     clean          — merged + pushed without LLM
  //     resolved       — CC resolved conflicts; merged + pushed
  //     conflict       — CC couldn't resolve; merge aborted, no push
  router.post('/api/sessions/:id/sync-main', drainGuard, async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      let session = rows[0];
      // A paused session is resumed for the user, as a message to it is:
      // paused is bookkeeping, never a step anybody is asked to take first.
      if (session.status === 'paused') {
        const resumed = await resumePausedSession({ pool, config, user: req.user, sessionId });
        if (!resumed.ok) return res.status(resumed.status).json({ error: resumed.error });
        session = { ...session, status: 'active' };
      }
      if (!['active', 'promoted'].includes(session.status)) {
        return res.status(409).json({
          error: `This ${session.status === 'archived' ? 'session is archived' : 'change is closed'}. Restore it first.`,
        });
      }

      // #252: a regular chat turn holds the worker — dispatching a sync
      // now would just trip execInWorker's "a turn is already in
      // flight" guard with a raw 500. Surface it as a friendly 409
      // instead. When the in-flight turn IS a sync, fall through:
      // runSyncMain coalesces and this caller joins the running sync.
      if (!syncMainSvc.getSyncState(sessionId)
          && isSessionBusy(sessionId)) {
        return res.status(409).json({
          error: 'Claude is still working in this session. Wait for the turn to finish before syncing.',
          busy: true,
        });
      }

      const result = await syncMainSvc.runSyncMain(config, pool, sessionId, { sessionRow: session });
      res.json(result);
    } catch (err) {
      log.error('sessions', 'sync-main failed', { sessionId, err: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Dev-chat file attachments (#450) ─────────────────────────────
  //
  // Upload happens BEFORE send: the client POSTs raw bytes here per
  // file, gets back an attachment id, and passes the ids to /chat which
  // links them to the user message row. The body is always
  // application/octet-stream (real type is derived server-side from the
  // filename extension + magic-byte sniff) — this deliberately sidesteps
  // the global express.json() parser, which only consumes JSON bodies,
  // so no server.js parser change is needed and a .json text file can
  // never be swallowed as a JSON request body.
  router.post(
    '/api/sessions/:id/attachments',
    attachmentUploadLimiter,
    // Limit must exceed the largest single-file cap (20 MB zips).
    express.raw({ type: 'application/octet-stream', limit: '21mb' }),
    async (req, res) => {
      try {
        const { rows: sessionRows } = await pool.query(
          `SELECT cs.id FROM chat_sessions cs
           WHERE cs.id = $1 AND cs.user_id = $2
             AND cs.status IN ('active', 'promoted')
             AND cs.is_headless = FALSE`,
          [req.params.id, req.user.id]
        );
        if (!sessionRows.length) return res.status(404).json({ error: 'Active session not found' });
        const sessionId = sessionRows[0].id;

        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = attachmentsSvc.validateUpload({ filename, data });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Per-session storage cap — the retention bound for linked rows
        // (orphans are GC'd by the server.js sweeper after 24h).
        const { rows: sumRows } = await pool.query(
          `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
             FROM chat_session_attachments WHERE session_id = $1`,
          [sessionId]
        );
        if (Number(sumRows[0].total) + data.length > attachmentsSvc.MAX_SESSION_BYTES) {
          return res.status(400).json({
            error: `This session's attachment storage is full (${Math.round(attachmentsSvc.MAX_SESSION_BYTES / 1024 / 1024)} MB max)`,
          });
        }

        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO chat_session_attachments
             (id, session_id, user_id, kind, filename, content_type, size_bytes, meta, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, sessionId, req.user.id, verdict.kind, filename, verdict.contentType, data.length,
           verdict.meta ? JSON.stringify(verdict.meta) : null, data]
        );
        return res.json({
          id, kind: verdict.kind, filename,
          contentType: verdict.contentType, sizeBytes: data.length,
          meta: verdict.meta || null,
        });
      } catch (err) {
        // express.raw over-limit bodies raise PayloadTooLargeError before
        // the handler runs; anything landing here is a genuine failure.
        log.error('sessions', 'Attachment upload failed', { sessionId: req.params.id, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // Serve attachment bytes. Authed + owner-gated (deliberately NOT the
  // pre-auth /visuals/:id pattern — attachments are private chat content
  // with no GitHub-camo requirement). Rows are immutable and ids are
  // unguessable, so a long private immutable cache is safe.
  router.get('/api/sessions/:id/attachments/:attId', async (req, res) => {
    const attId = String(req.params.attId || '');
    if (!/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        `SELECT att.kind, att.filename, att.content_type, att.data
           FROM chat_session_attachments att
           JOIN chat_sessions cs ON cs.id = att.session_id
          WHERE att.id = $1 AND att.session_id = $2 AND cs.user_id = $3`,
        [attId, req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).end();
      const att = rows[0];
      // Text always serves as text/plain (set at upload) and downloads as
      // an attachment; images render inline. nosniff so a browser can
      // never promote either into something executable.
      const safeName = String(att.filename || 'file').replace(/["\\\r\n]/g, '_');
      res.set('Content-Type', att.content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', `${att.kind === 'image' ? 'inline' : 'attachment'}; filename="${safeName}"`);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('sessions', 'Attachment serve failed', { attId, err: err.message });
      return res.status(500).end();
    }
  });

  // Send a message in a dev chat session — Mayor + Claude Code pattern.
  // chatLimiter caps a single user at 30 chat turns/min so a runaway
  // script can't drain their daily LLM cap before checkBudget() can
  // even respond. See src/middleware/rate-limits.js.
  //
  // Delivery (#3177, services/chat-delivery.js): the stream's first event
  // is `accepted` { messageId, clientMessageId }, written once the message
  // is stored, so a client whose stream breaks after it knows the message
  // arrived. To resume, open GET /api/sessions/:id/events?since=<that
  // event's _seq>. An optional `client_message_id` makes a retry safe: the
  // same id again answers with the stored message's `accepted` event
  // (duplicate: true) instead of starting a second turn, and
  // GET /api/sessions/:id/status?client_message_id=<id> looks it up.
  router.post('/api/sessions/:id/chat', chatLimiter, drainGuard, async (req, res) => {
    const { message, model, attachmentIds } = req.body;

    // #450: attachments may accompany (or replace) the typed message.
    const attIds = attachmentsSvc.sanitizeAttachmentIds(attachmentIds);
    if (attIds === null) {
      return res.status(400).json({ error: `Bad attachments (max ${attachmentsSvc.MAX_PER_MESSAGE} per message)` });
    }
    const clientId = chatDelivery.readClientMessageId(req.body);
    if (clientId.present && !clientId.value) {
      return res.status(400).json({ error: chatDelivery.BAD_CLIENT_MESSAGE_ID });
    }
    const clientMessageId = clientId.value;
    if (!message?.trim() && !attIds.length) {
      return res.status(400).json({ error: 'Message required' });
    }
    // Downstream code (prompt assembly, titling, dispatch args) never
    // sees empty content — an attachments-only send gets a stub caption.
    const messageText = message?.trim() || attachmentsSvc.ATTACHMENTS_ONLY_TEXT;

    try {
      const loadChatSession = () => pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2
           AND cs.status IN ('active', 'promoted')
           AND cs.is_headless = FALSE
           -- #846: an imported PR has no dev chat — its branch belongs to an
           -- external author on GitHub. Excluded here so a stray client can
           -- never dispatch an AI dev turn onto someone else's branch; the
           -- 409 below names the reason rather than a bare 404.
           AND cs.source IS DISTINCT FROM 'imported'`,
        [req.params.id, req.user.id]
      );
      let { rows: sessionRows } = await loadChatSession();
      if (!sessionRows.length) {
        // A message to a paused session resumes it (#2779 follow-up): paused
        // is bookkeeping, never something the user is asked to undo first.
        // The resume keeps every rule the resume route has (the caps, and
        // pausing the user's least recently used session to make room).
        const { rows: pausedRows } = await pool.query(
          `SELECT id, agent_session_id FROM chat_sessions
            WHERE id = $1 AND user_id = $2 AND status = 'paused'
              AND is_headless = FALSE AND source IS DISTINCT FROM 'imported'`,
          [req.params.id, req.user.id]
        );
        // Refused below anyway, so it is never resumed first: a resume
        // spends a slot and may pause another of the user's sessions.
        if (pausedRows.length && pausedRows[0].agent_session_id != null) {
          return res.status(409).json({
            error: 'This change belongs to an agent session. Continue it there.',
            agentSessionId: pausedRows[0].agent_session_id,
          });
        }
        if (pausedRows.length) {
          const resumed = await resumePausedSession({
            pool, config, user: req.user, sessionId: Number(pausedRows[0].id),
          });
          if (!resumed.ok) return res.status(resumed.status).json({ error: resumed.error });
          ({ rows: sessionRows } = await loadChatSession());
        }
      }
      if (!sessionRows.length) {
        const { rows: importedRows } = await pool.query(
          `SELECT 1 FROM chat_sessions
            WHERE id = $1 AND user_id = $2 AND source = 'imported'`,
          [req.params.id, req.user.id]
        );
        if (importedRows.length) {
          return res.status(409).json({
            error: 'This proposal was imported from GitHub, so it has no dev chat. Discuss it on the proposal page instead.',
          });
        }
        return res.status(404).json({ error: 'Active session not found' });
      }
      const session = sessionRows[0];
      // #2779: a change started from an agent session has no chat of its
      // own. Its conversation is the agent session's, where the Mayor that
      // started it runs every turn; two chats driving one branch would race.
      if (session.agent_session_id != null) {
        return res.status(409).json({
          error: 'This change belongs to an agent session. Continue it there.',
          agentSessionId: session.agent_session_id,
        });
      }
      // #3177: ahead of the billing and attachment gates, which a retry
      // must not trip: its turn was paid for once and its attachments are
      // already linked to the stored message.
      if (clientMessageId) {
        const delivery = await chatDelivery.lookup(pool, {
          sessionId: session.id, clientMessageId, viewer: req.user,
        });
        if (delivery.received) return chatDelivery.answerDuplicate(res, delivery);
      }
      const isOpenRouterSession = registry.resolveBackend(session.agent_backend) === 'codex_openrouter';

      // Resolve who pays for this turn once up front (#212): the shared
      // daily allowance is consumed first, and the caller's BYOK key
      // (#30) takes over only after the budget (user or global cap) is
      // exhausted. `userApiKey` therefore reflects the ACTUAL payer for
      // the whole turn — null = platform-billed, non-null = the user's
      // own key — so every recordSpend(..., { byok: !!userApiKey })
      // below routes the cost to the right bucket. Allowance gone and
      // no key on file → the same 429 as always, tagged with a code so
      // the client can tell it apart from a chatLimiter throttle (#463).
      // OpenRouter sessions are a single-provider path: their selected model
      // handles the whole turn directly, so they never draw on an Anthropic
      // key. #2571 splits them by WHOSE OpenRouter key it is. The included
      // (company-funded) key is platform money and shares ONE weekly pool
      // with Claude spend, so it is gated here by the same checkBudget —
      // without resolveBillingPath, whose BYOK spill-over and "add your own
      // Anthropic key" advice belong to the Claude path alone. A personal
      // key the user pasted in is their own money: neither blocked nor
      // billed, exactly as before. Claude sessions retain the existing
      // limit-first platform/BYOK contract.
      let billing = { apiKey: null };
      if (isOpenRouterSession) {
        if (await managedOpenRouter.usesIncludedKey(pool, req.user.id)) {
          const budget = await limits.checkBudget(pool, req.user.id);
          if (budget.error) return res.status(429).json({
            error: budget.error,
            code: 'budget_exceeded',
            reason: budget.reason || null,
            verificationRequired: !!budget.verificationRequired,
          });
        }
      } else {
        billing = await limits.resolveBillingPath(pool, config.dataEncryptionKey, req.user.id);
        if (billing.error) return res.status(429).json({
          error: billing.error,
          code: 'budget_exceeded',
          reason: billing.reason || null,
          verificationRequired: !!billing.verificationRequired,
        });
      }
      // Mutable since #664: an expensive CC phase can exhaust the
      // allowance mid-turn, so billing is re-resolved after the tool
      // completes and the wrap-up phase bills the fresh payer.
      let userApiKey = billing.apiKey;

      // #450: verify every attachment id is this user's, this session's,
      // and unlinked BEFORE inserting the message row (we're still in
      // plain-JSON response land here — after the SSE writeHead below,
      // 4xx replies are no longer possible).
      let turnAttachments = [];
      if (attIds.length) {
        const { rows: attRows } = await pool.query(
          `SELECT id, kind, filename, content_type, size_bytes, meta
             FROM chat_session_attachments
            WHERE id = ANY($1) AND session_id = $2 AND user_id = $3
              AND message_id IS NULL
            ORDER BY created_at ASC, id ASC`,
          [attIds, session.id, req.user.id]
        );
        if (attRows.length !== attIds.length) {
          return res.status(400).json({ error: 'Unknown or already-sent attachment' });
        }
        turnAttachments = attRows;
      }
      // #1350: this is where a native session's branch comes from. Sessions
      // are created branchless, so the first turn is the first thing that
      // needs a ref, and ensureSessionBranch() is idempotent for every turn
      // after it.
      //
      // Placement is deliberate, on both sides:
      //
      //   * AFTER every 4xx gate above (repo, status, billing path,
      //     attachment ownership) and BEFORE the message insert, so a turn
      //     that was going to be refused anyway mints nothing, and a mint
      //     that fails leaves no orphan user message in the transcript.
      //   * BEFORE res.writeHead() below. Once the SSE stream opens, a 4xx
      //     reply is no longer possible, and "GitHub would not create your
      //     branch" is exactly the kind of failure that has to arrive as a
      //     status code rather than as a chat message.
      //
      // It covers the local-agent path too: runLocally turns still push
      // through the platform, so they need the ref just as much.
      //
      // The helper is idempotent on its own, but skip it outright once the
      // row already carries a name: every turn after the first would
      // otherwise open a transaction and take a row lock to re-read a value
      // this handler is already holding.
      if (!String(session.branch_name || '').trim()) {
        try {
          const ensured = await sessionLifecycle.ensureSessionBranch({
            pool, sessionId: session.id, username: req.user.username,
          });
          session.branch_name = ensured.branchName;
        } catch (err) {
          log.warn('sessions', 'Could not prepare session branch for first turn', {
            sessionId: session.id, code: err.code || null, message: err.message,
          });
          return res.status(503).json({
            error: err.userMessage
              || 'Homeroom could not prepare this session\'s branch. Send your message again in a moment.',
          });
        }
      }

      const userMeta = turnAttachments.length
        ? {
            attachments: turnAttachments.map((a) => ({
              id: a.id, kind: a.kind, filename: a.filename,
              contentType: a.content_type, sizeBytes: a.size_bytes,
              ...(a.meta ? { meta: a.meta } : {}),
            })),
          }
        : {};

      // #3177: ON CONFLICT covers two retries racing past the lookup above;
      // the one that loses answers as a duplicate. A row without a
      // client_message_id never conflicts.
      const { rows: userMsgRows } = await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, client_message_id)
         VALUES ($1, 'user', $2, $3, $4)
         ON CONFLICT (session_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [session.id, messageText, JSON.stringify(userMeta), clientMessageId]
      );
      if (clientMessageId && !userMsgRows.length) {
        return chatDelivery.answerDuplicate(res, await chatDelivery.lookup(pool, {
          sessionId: session.id, clientMessageId, viewer: req.user,
        }));
      }
      const userMessageId = userMsgRows[0]?.id ?? null;
      if (turnAttachments.length) {
        await pool.query(
          `UPDATE chat_session_attachments SET message_id = $1 WHERE id = ANY($2)`,
          [userMsgRows[0].id, attIds]
        );
      }
      // Mark the session as freshly active so the auto-pause sweeper
      // leaves it alone (see server.js session sweeper + schema
      // last_activity_at). A chat turn is the strongest activity signal.
      // Sending a message also proves presence, so any stale
      // notify-on-done arming from a previous turn is reset (#161).
      await pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW(), notify_on_done = FALSE WHERE id = $1`,
        [session.id]
      );

      // Validate against the server-side allowlist (src/services/models.js).
      // A bogus or unrecognized `model` falls back to the default — this
      // is the user-facing escape hatch for HIGH #2 (client-controlled
      // model name). The same allowlist powers the UI dropdown via
      // GET /api/models, so there's no drift between what the UI
      // offers and what the server accepts.
      const selectedModel = models.resolve(model);

      // SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // #2779: the turn itself (the stream, the Mayor loop, the dispatch and
      // its wrap-up) runs in services/mayor/turn.js.
      await runMayorTurn({
        session,
        isOpenRouterSession,
        res,
        pool,
        config,
        req,
        messageText,
        selectedModel,
        turnAttachments,
        scheduleInteractiveRecovery,
        userApiKey,
        userMessageId,
        clientMessageId,
      }, MAYOR_TURN_DEPS);
    } catch (err) {
      log.error('sessions', 'Chat setup error', { message: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ===== Spec stage endpoints =====
  //
  // The session has a working buffer (chat_sessions.spec_md, overwritten
  // by the Mayor's dispatch_scout) and an append-only history of
  // immutable numbered versions in chat_session_specs.
  // A version is frozen on every spec mutation (#27, via
  // snapshotSessionSpec), so spec_md is always byte-identical to the
  // latest version. Numbered versions (v1…vN) are the single spec
  // surface the dev-chat viewer presents (#69 removed the separate
  // "Draft (live)" entry and the manual "Save version" step); spec_md
  // is kept purely as the live-draft buffer the scout revises against
  // and as a theme signal for PR metadata. The dev-chat UI surfaces the spec
  // in a read-only side-panel viewer (see DevChat.specViewer in
  // public/js/dev-chat.js); the user ships it by asking the Mayor to
  // dispatch the coding agent in chat — there is no in-UI "Build from
  // spec" button.
  //
  // Read-only fetch returning the latest spec content plus metadata for
  // every visible version so the dev-chat can populate its version
  // selector without a second round-trip; full content of older versions
  // comes from GET /specs/:version below.
  //
  // Access rule (mirrors GET /specs/:version, which this list feeds):
  //   - Owner: the live draft (spec_md, == the latest version's content)
  //     plus ALL frozen versions — drafts stay private until shared.
  //   - Anyone else (admins included — sharing is the explicit act that
  //     makes a spec visible, same rule as the single-version gate):
  //     only versions matching specVersionSharedVisibilitySql, with
  //     `spec` set to the newest VISIBLE version's content — never
  //     spec_md, which can be ahead of the last shared version. Zero
  //     visible versions keeps today's 404, so nothing new is revealed
  //     about sessions whose specs were never shared.
  router.get('/api/sessions/:id/spec', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.spec_md
         FROM chat_sessions cs
         WHERE cs.id = $1`,
        [req.params.id]
      );

      if (sessionRows.length && sessionRows[0].user_id === req.user.id) {
        const { rows: versions } = await pool.query(
          `SELECT version, built_at, commit_sha, pr_number, shared_to_group_at,
                  LENGTH(content) AS char_count
           FROM chat_session_specs
           WHERE session_id = $1
           ORDER BY version DESC`,
          [req.params.id]
        );
        return res.json({
          spec: sessionRows[0].spec_md || '',
          versions,
        });
      }

      if (sessionRows.length) {
        // Non-owner: shared versions only. `content` rides along so the
        // newest visible version can serve as `spec` without a second
        // query, then is stripped from the metadata rows.
        const { rows } = await pool.query(
          `SELECT version, built_at, commit_sha, pr_number, shared_to_group_at,
                  LENGTH(content) AS char_count, content
           FROM chat_session_specs s
           WHERE s.session_id = $1
             AND ${specVersionSharedVisibilitySql('s', '$2')}
           ORDER BY version DESC`,
          [req.params.id, req.user.id]
        );
        if (rows.length) {
          return res.json({
            spec: rows[0].content || '',
            versions: rows.map(({ content, ...meta }) => meta),
          });
        }
      }

      // (#1012) Staging-only demo fallback (?demo=1): chat_session_specs
      // is staging:private, so a non-owner's spec panel has nothing real
      // to list in a preview. Read-path only, gated on staging + the
      // explicit demo flag, and reached only when no real data matched —
      // production and any real spec are untouched.
      if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
        return res.json(stagingMockSpecList());
      }

      return res.status(404).json({ error: 'Session not found' });
    } catch (err) {
      log.error('sessions', 'Failed to get spec', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fetch a frozen historical version verbatim. The spec viewer uses
  // this when the user picks an older version from the dropdown.
  // (User hand-edits via PUT /spec were dropped — the Mayor /
  // dispatch_scout writes the live draft and the user only ever views
  // the result. Old sessions that already have frozen versions in
  // chat_session_specs keep their browseable history through this
  // endpoint and the share endpoint below.)
  //
  // Access rule:
  //   - Owner of the originating session: every version (saved drafts
  //     are private until explicitly shared).
  //   - Anyone else (any authed user): only versions where
  //     shared_to_group_at IS NOT NULL — i.e. the spec was explicitly
  //     posted into the app's group chat via /specs/:version/share.
  //     The group-chat read endpoint has no membership gate, so once
  //     a spec is shared every logged-in user can already see the
  //     share card; the body of the spec should be reachable too,
  //     otherwise the "View full spec" affordance on the card 404s
  //     for everyone except the original sharer (#6).
  //   - (#86) A user the owner privately shared this exact version with
  //     via POST /specs/:version/share-user — the
  //     chat_session_spec_user_shares row is the authorization source
  //     of truth, scoped to (session, version, recipient).
  // The non-owner arm lives in specVersionSharedVisibilitySql, shared
  // verbatim with the version-list route (GET /spec) above so the two
  // gates cannot drift.
  router.get('/api/sessions/:id/specs/:version', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT s.version, s.content, s.built_at, s.commit_sha, s.pr_number, s.shared_to_group_at
         FROM chat_session_specs s
         JOIN chat_sessions cs ON cs.id = s.session_id
         WHERE s.session_id = $1
           AND s.version = $2
           AND (cs.user_id = $3 OR ${specVersionSharedVisibilitySql('s', '$3')})`,
        [sessionId, version, req.user.id]
      );
      if (!rows.length) {
        // (#1012) Staging-only demo fallback (?demo=1): chat_session_specs
        // is staging:private, so cloned group-chat spec cards have nothing
        // to load. Read-path only, gated on staging + the explicit demo
        // flag, and reached only when no real row matched — production and
        // any real spec are untouched.
        if (process.env.USERNODE_ENV === 'staging' && req.query.demo === '1') {
          return res.json({ spec: stagingMockSpecVersion(version) });
        }
        return res.status(404).json({ error: 'Spec version not found' });
      }
      res.json({ spec: rows[0] });
    } catch (err) {
      log.error('sessions', 'Failed to get spec version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // (#69) The manual POST /api/sessions/:id/specs "Save version" route
  // was retired. Every Mayor spec mutation (scout) already
  // auto-freezes an immutable numbered version via
  // snapshotSessionSpec(), so the live spec_md is always byte-identical
  // to the latest chat_session_specs row. The old route just re-snapped
  // that same content and almost always hit its own dedup branch — a
  // no-op. snapshotSessionSpec() is now the sole writer of new versions;
  // the dev-chat spec viewer shares any numbered version directly with
  // no save step in between.

  // Share a frozen spec snapshot into the app's group chat. The group
  // chat renders the message as a "spec card" with a snippet + view-
  // full-spec affordance; the underlying chat_messages row carries
  // metadata.specShare so the renderer knows to upgrade it from a
  // plain system line.
  router.post('/api/sessions/:id/specs/:version/share', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.app_id, a.slug as app_slug
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
      const { app_id: appId, app_slug: appSlug } = sessionRows[0];

      const { rows: specRows } = await pool.query(
        `SELECT version, content, built_at, commit_sha, pr_number
         FROM chat_session_specs
         WHERE session_id = $1 AND version = $2`,
        [sessionId, version]
      );
      if (!specRows.length) return res.status(404).json({ error: 'Spec version not found' });
      const spec = specRows[0];

      // Title + snippet for the card. The title is the first H1
      // (`# Heading`) in the spec, used as the card's primary heading
      // so users see what the spec is *about* instead of just "v3".
      // The snippet is the body content with the title line stripped
      // (otherwise it'd appear twice — once in the card header, once
      // at the top of the snippet body). Old shares predate this
      // payload shape and have no title; the renderer falls back to
      // "Spec vN" in that case.
      const title = extractSpecTitle(spec.content);
      const snippet = extractSpecSnippet(spec.content, title);

      const shareMeta = {
        specShare: {
          sessionId,
          version: spec.version,
          builtAt: spec.built_at,
          commitSha: spec.commit_sha || null,
          prNumber: spec.pr_number || null,
          title,
          snippet,
          totalChars: (spec.content || '').length,
          sharedBy: { id: req.user.id, username: req.user.username },
        },
      };
      const summaryLine = title
        ? `📋 ${req.user.username || 'Someone'} shared "${title}" (spec v${spec.version}).`
        : `📋 ${req.user.username || 'Someone'} shared spec v${spec.version} from a dev session.`;

      const { rows: msgRows } = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata)
         VALUES ($1, $2, $3, 'spec_share', $4)
         RETURNING id, created_at`,
        [appId, req.user.id, summaryLine, JSON.stringify(shareMeta)]
      );

      await pool.query(
        `UPDATE chat_session_specs SET shared_to_group_at = NOW()
         WHERE session_id = $1 AND version = $2 AND shared_to_group_at IS NULL`,
        [sessionId, version]
      );

      // Broadcast to room subscribers using the same envelope the WS
      // group-chat handler emits, so the existing renderMessageHtml
      // path picks it up. We also fan out the metadata so the card has
      // everything it needs without a follow-up fetch.
      const { broadcast } = require('../services/ws');
      broadcast(appId, {
        type: 'chat',
        id: msgRows[0].id,
        userId: req.user.id,
        username: req.user.username,
        content: summaryLine,
        msgType: 'spec_share',
        metadata: shareMeta,
        createdAt: msgRows[0].created_at,
      });

      res.json({ ok: true, appSlug, messageId: msgRows[0].id });
    } catch (err) {
      log.error('sessions', 'Share spec failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // (#86) Privately share a frozen spec version with ONE user. Unlike
  // the group share above, nothing is posted to chat and the spec is
  // NOT marked shared_to_group_at — the recipient gets a 'spec_shared'
  // notification that deep-links into the read-only spec panel, and the
  // chat_session_spec_user_shares row widens the GET /specs/:version
  // gate for exactly (session, version, recipient). Repeatable: the
  // owner can share with several people one at a time; re-sharing with
  // the same person is an idempotent no-op (no second notification).
  router.post('/api/sessions/:id/specs/:version/share-user', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!username) return res.status(400).json({ error: 'Username required' });

    try {
      // Owner-only, same as the group-share route.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.app_id
         FROM chat_sessions cs
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
      const appId = sessionRows[0].app_id;

      const { rows: specRows } = await pool.query(
        `SELECT version FROM chat_session_specs
         WHERE session_id = $1 AND version = $2`,
        [sessionId, version]
      );
      if (!specRows.length) return res.status(404).json({ error: 'Spec version not found' });

      const users = await notifications.resolveUsers(pool, [username.toLowerCase()]);
      if (!users.length) return res.status(404).json({ error: 'User not found' });
      const recipient = users[0];
      if (recipient.id === req.user.id) {
        return res.status(400).json({ error: 'You already have this spec' });
      }

      // Collab-private apps: a share must not grant a non-member a spec
      // they'd have no app context for. Explicit error (not a silent
      // drop) — the sharer needs the feedback.
      const allowed = await notifications.filterToCollaborators(pool, appId, [recipient.id]);
      if (!allowed.includes(recipient.id)) {
        return res.status(400).json({ error: "That user doesn't have access to this app" });
      }

      const { rowCount } = await pool.query(
        `INSERT INTO chat_session_spec_user_shares (session_id, version, recipient_id, shared_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, version, recipient_id) DO NOTHING`,
        [sessionId, version, recipient.id, req.user.id]
      );
      if (rowCount === 0) {
        // Already shared with this person — re-shares must not re-ping.
        return res.json({ ok: true, alreadyShared: true, recipient: { username: recipient.username } });
      }

      const rows = await notifications.createSpecSharedNotification(pool, {
        recipientId: recipient.id,
        appId,
        sessionId,
        sharerId: req.user.id,
        version,
      });
      for (const row of rows) await notifications.hydrateAndPush(pool, row);

      res.json({ ok: true, recipient: { username: recipient.username } });
    } catch (err) {
      log.error('sessions', 'Share spec to user failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #906: the side-slot staging fixtures (seedStagingCcCohortRuns in
  // src/db/migrate.js) seed active coding-run rows at 5 and 12 minutes
  // elapsed so a reviewer can see the empty slot and the ten-minute long-run
  // note without waiting out a real run. But the dev-chat client applies its
  // `_active` flag — which is what makes the row render as a LIVE run with a
  // ticking elapsed timer and a side slot at all — only when /status reports
  // `busy`, and `busy` is derived purely from the in-memory worker
  // registries below. No DB seed can reach those, so without this the
  // fixtures render as finished rows and demonstrate nothing.
  //
  // This is DATA/STATE gating, not feature gating: the code path, the payload
  // shape and the whole client are identical, only the seeded rows' state
  // differs, and it is a strict no-op outside staging. The id set is resolved
  // once and cached, so the 3s status poll costs nothing.
  //
  // #1378: the set became a Map because `stoppable` is now part of the
  // payload and the fixtures have to be able to show BOTH answers. A seeded
  // fixture has no in-memory stop handle and no durable active_turn, so it
  // would compute stoppable:false for all of them — regressing the two
  // estimator fixtures to the "Finishing up…" spinner and breaking the
  // checks that assert their cohort note. The '-unstoppable' fixture is the
  // one that deliberately keeps the false answer.
  let stagingCohortFixtureIds = null;
  async function stagingCohortFixtureSessions() {
    if (process.env.USERNODE_ENV !== 'staging') return null;
    if (stagingCohortFixtureIds) return stagingCohortFixtureIds;
    try {
      const { rows } = await pool.query(
        `SELECT id, branch_name FROM chat_sessions
          WHERE branch_name LIKE 'staging-fixture/cc-cohort-%'`
      );
      stagingCohortFixtureIds = new Map(rows.map((r) => [
        r.id,
        { stoppable: !String(r.branch_name || '').endsWith('-unstoppable') },
      ]));
    } catch {
      stagingCohortFixtureIds = new Map();
    }
    return stagingCohortFixtureIds;
  }

  // Check if a session has an active worker + get latest progress
  //
  // #3177: `?client_message_id=<id>` (or `clientMessageId`) adds `delivery`,
  // the lookup for a message sent with that id through POST /chat:
  // { clientMessageId, received: false } when no such message is stored (or
  // the caller does not own the session), else { clientMessageId,
  // received: true, messageId, state: 'received' | 'running' | 'done',
  // since }. `since` is the message's `accepted` _seq while this process
  // still buffers it, for GET /events?since=; null means reload the
  // transcript instead. `delivery` is null when the lookup itself failed.
  router.get('/api/sessions/:id/status', async (req, res) => {
    const sessionId = parseInt(req.params.id);
    const deliveryId = chatDelivery.readClientMessageId(req.query);
    if (deliveryId.present && !deliveryId.value) {
      return res.status(400).json({ error: chatDelivery.BAD_CLIENT_MESSAGE_ID });
    }
    // "busy" = a CC/scout dispatch is actively running for this
    // session right now. We deliberately do NOT key on
    // `containerStatus === 'running'` here — since the warm-CC commit
    // (eb62570 "keep cc warm between calls") the worker container
    // stays running between dispatches, so a running container only
    // means "the wrapper is sleep-looping", not "claude is busy".
    // Using container-status as the busy signal would strand the
    // dev-chat polling fallback in `busy: true` for the full ~10-min
    // idle-eviction window whenever the POST SSE drops before
    // delivering `done`.
    //
    // `activeWorkers` covers the in-flight window from the chat
    // handler's POV (added before ensureWorker, deleted in
    // run(Scout|ClaudeCode)Tool's finally). `worker.isInFlight`
    // covers the inner exec window (set by execInWorker around the
    // actual `docker exec`) — redundant in normal flow, but a useful
    // safety net for adopted workers and the brief period between
    // adding to activeWorkers and registering with the warm registry.
    let busy = isSessionBusy(sessionId);
    // #906 staging fixtures — see stagingCohortFixtureSessions above.
    let fixtureStoppable = null;
    if (!busy) {
      const fixtures = await stagingCohortFixtureSessions();
      const fixture = fixtures && fixtures.get(sessionId);
      if (fixture) {
        busy = true;
        fixtureStoppable = fixture.stoppable;
      }
    }

    // Same visibility rule as /checks and /details: the progress log, spend,
    // estimate and runner name below are the session's own, so a caller who
    // may not see the session gets the same 404 as for a missing one.
    try {
      const { rows: seen } = Number.isNaN(sessionId) ? { rows: [] } : await pool.query(
        'SELECT user_id, status, shared_at FROM chat_sessions WHERE id = $1',
        [sessionId]
      );
      if (!canViewSession(seen[0], req.user)) return res.status(404).json({ error: 'Session not found' });
    } catch (err) {
      log.warn('sessions', 'Status visibility lookup failed', { sessionId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }

    let progress = [];
    let progressAgentBackend = null;
    let progressAgentModel = null;
    try {
      const { rows } = await pool.query(
        `SELECT metadata FROM chat_session_messages
         WHERE session_id = $1 AND role = 'system' AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );
      if (rows[0]?.metadata?.progressLog) {
        progress = rows[0].metadata.progressLog;
        progressAgentBackend = rows[0].metadata.agentBackend || null;
        progressAgentModel = rows[0].metadata.agentModel || null;
      }
    } catch {}
    // During bootstrap the latest durable row can still belong to the prior
    // turn. An in-memory entry, when it has a backend, is necessarily the
    // current run and therefore wins for identity (especially when a
    // Codex-pinned session is executing on an attached local Claude agent).
    // Fall back to the durable row only before current progress has begun.
    const liveProgress = workerProgress.get(sessionId);
    if (liveProgress?.backend) {
      progressAgentBackend = liveProgress.backend;
      progressAgentModel = liveProgress.model || null;
    }

    // Current turn phase (mayor1 / cc / mayor2). Lets the client pick
    // between the stop button and the finishing-up spinner on refresh
    // without guessing from container status alone.
    const stopHandleNow = stopRegistry.get(sessionId);
    const phase = stopHandleNow?.phase || null;

    // #1378: whether POST /stop can actually do anything for this session.
    //
    // `busy` and "stoppable" are NOT the same fact, and conflating them is
    // what produced the reported bug. `busy` is true for anything holding
    // the session — an adopted turn, a handoff pipeline, a proposal
    // handoff — while only a turn with a stop handle (or a durable
    // active_turn still in a recoverable phase, which the recovery path
    // will register a handle for) can be stopped. The client used to
    // assume every busy session was stoppable and painted a live red Stop
    // that answered { stopped: false }; it now paints the "Finishing up…"
    // spinner instead when this is false, so the affordance matches what
    // the server will do.
    let durableTurn = null;
    try {
      durableTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch {}
    const durableRecoverable = !!durableTurn
      && turnLifecycle.RECOVERABLE_PHASES.has(turnLifecycle.phaseOf(durableTurn));
    const stoppable = fixtureStoppable === null
      ? (!!stopHandleNow || durableRecoverable)
      : fixtureStoppable;

    // #889: a stop has been requested for this turn but it hasn't unwound
    // yet. Lets a reloading client (and the 3s poll fallback) repaint the
    // "Stopping…" button instead of a live red Stop for a turn that is
    // already being killed.
    //
    // #1378: falls back to the durable stamp. A stop clicked just before a
    // restart lives on the turn record, not in this process's memory, so
    // without the fallback the client repaints a calm red Stop for a turn
    // that is already ending.
    const durableStop = turnLifecycle.stopRequestOf(durableTurn);
    const stopping = stopHandleNow ? !!stopHandleNow.stopped : !!durableStop;

    // #937: WHEN the stop was requested, so a reloading client (or a second
    // tab joining mid-stop) rebuilds its escalation ladder at the right
    // rung instead of restarting a calm "Stopping…" that never escalates.
    // Null whenever no stop is pending.
    const stopRequestedAt = stopHandleNow
      ? (stopHandleNow.stopRequestedAt || null)
      : (durableStop?.atMs || null);

    // Experimental AI progress estimate: latest in-memory Haiku guess for
    // the run, so the 3s polling fallback carries it when SSE/WS drop.
    // Null whenever the per-user toggle is off or no estimate exists yet —
    // and, since #891, from the coding run's terminal marker onward
    // (workerProgress.clearEstimate), so the poll stops re-serving a stale
    // guess through PR creation, the staging build and the Mayor wrap-up.
    // Carries `estimatedAt` so the client anchors its count-down absolutely
    // instead of restarting it on every 3s poll.
    const estimate = workerProgress.get(sessionId)?.estimate || null;

    // #239: whether the auto-conflict-resolver currently has a resolve
    // in flight for this session. The client's "resolving merge
    // conflicts" banner used to poll this as its reload-recovery and
    // missed-WS-event safety net; that banner was retired in #962, so
    // no client reads this today. Kept as a cheap, honest fact about
    // the session for admin/debug tooling and future surfaces — the
    // per-proposal badge derives the same state from the WS
    // `resolving` broadcasts + the merge_conflict_state snapshot.
    const { isResolving } = require('../services/conflict-resolver');

    // Merge lifecycle status ('promoted' | 'merging' | 'merged' | …).
    // The self-app "Platform updating…" banner's restore path used to
    // verify against this that the merge behind a restored banner was
    // still in flight; that banner was removed in #1015, so no client
    // reads this today. Kept — like the neighbouring `resolving` field —
    // as a cheap, honest fact about the session for admin/debug tooling
    // and future surfaces, since the poll already has the row in hand.
    let mergeStatus = null;
    // #907: which runner owns this session. `runner` is where the LAST turn
    // ran ('local' | 'platform' | null); `localAgent` is non-null only while
    // a machine is currently attached, and is what the dev-chat "Running on
    // your machine" chip and the Run-on selector restore themselves from
    // after a reload.
    let runner = null;
    let runnerLabel = null;
    let attached = null;
    try {
      const { rows } = await pool.query(
        `SELECT status, last_turn_runner, local_agent_label
           FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      mergeStatus = rows[0]?.status || null;
      runner = rows[0]?.last_turn_runner || null;
      // The name of the machine the LAST turn ran on, which outlives the
      // lease. Without it, a session whose laptop has since detached can
      // only say "your machine" — and the whole point of the past-tense
      // chip is telling the user which one.
      runnerLabel = rows[0]?.local_agent_label || null;
    } catch {}
    try {
      attached = localAgent.publicLease(await localAgent.activeLease(pool, sessionId));
    } catch {}
    // Staging mock data: session_agent_leases is `staging:private`, so no
    // clone ever has a lease and the chip/selector review as dead controls.
    // Request-time only, no write, strict no-op outside USERNODE_ENV=staging.
    if (localAgentDemo.isStagingDemo(req)) {
      const demo = localAgentDemo.demoSessionRunner(sessionId);
      runner = demo.runner;
      runnerLabel = demo.localAgent.label;
      attached = demo.localAgent;
    }

    let delivery;
    if (deliveryId.value) {
      try {
        delivery = await chatDelivery.lookup(pool, {
          sessionId, clientMessageId: deliveryId.value, viewer: req.user,
        });
      } catch (err) {
        log.warn('sessions', 'Delivery lookup failed', { sessionId, err: err.message });
        delivery = null;
      }
    }

    // #252: in-flight sync-with-main state ({ phase, startedAt } |
    // null) — the dev-chat sync banner's reload recovery and poll
    // fallback read this the same way the resolving banner reads
    // `resolving`.
    // Keys: busy, progress, phase, stopping, stopRequestedAt, stoppable,
    // estimate
    // (+ resolving, sync, status, and `delivery` when asked for, #3177).
    // `estimate` is { text, remainingSeconds,
    // estimatedAt } | null — see workerProgress.setEstimate /
    // clearEstimate. `stopRequestedAt` is epoch ms | null (#937) and drives
    // the client's stop-escalation ladder across reloads.
    res.json({
      busy, progress, phase, stopping, stopRequestedAt, stoppable, estimate,
      spend: busy ? workerProgress.get(sessionId)?.spend || null : null,
      agentBackend: progressAgentBackend,
      agentModel: progressAgentModel,
      resolving: isResolving(sessionId),
      sync: syncMainSvc.getSyncState(sessionId),
      status: mergeStatus,
      runner, runnerLabel, localAgent: attached,
      ...(delivery !== undefined ? { delivery } : {}),
    });
  });

  // Stop an in-flight turn (#28). Aborts the Mayor's Anthropic stream
  // during phase-1 and/or `docker stop`s the Claude Code worker during
  // the CC phase. Deliberately does NOT abort Mayor phase-2 — by then
  // the commit + PR + staging already exist, and stopping the summary
  // would leave the user without context for changes that are real.
  router.post('/api/sessions/:id/stop', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });
    try {
      const result = await requestSessionStop({
        pool, sessionId, user: req.user, force: req.body?.force === true, scheduleInteractiveRecovery,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      log.error('sessions', 'Stop failed', { sessionId, message: err.message });
      return res.status(503).json({ error: 'Could not confirm that the agent stopped. Retry Stop.', code: 'stop_unconfirmed' });
    }
  });

  // Resumable SSE subscription for a single session's event stream.
  // Intended as a reconnect channel when the primary POST /chat SSE
  // response drops mid-run: the client opens an EventSource here, and
  // EventSource's built-in retry + Last-Event-Id gives us exactly-once
  // delivery (relative to the bus's ring buffer) without us having to
  // reinvent reconnection logic.
  //
  // The client may also pass `?since=<seq>` explicitly on the first
  // connect to replay from a specific point (e.g. the last _seq it saw
  // on the POST stream before it died).
  //
  // #3177: every turn's first event is `accepted`, so a client whose POST
  // stream broke after any bytes at all has a `since` to resume from, and
  // `since=<accepted _seq>` replays the whole turn from its start. The
  // buffer is per process and cleared ~30s after a turn ends, so a resume
  // after a restart or long after the turn replays nothing: GET /status
  // (`busy`, and `delivery` for a client_message_id) says whether the turn
  // is still running, and GET /api/sessions/:id has the stored transcript.
  router.get('/api/sessions/:id/events', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (!sessionId) return res.status(400).end();

    // Scope to sessions the caller can see. Admins should see everything
    // (same as elsewhere in this file) but regular users only their own.
    try {
      const { rows } = await pool.query(
        `SELECT user_id FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).end();
      // Same camelCase fix as the recheck route below: `is_admin` never
      // existed on req.user, so admins were silently scoped like regular
      // users here. Read-only access — plain isAdmin is the right gate.
      if (!req.user?.isAdmin && rows[0].user_id !== req.user?.id) {
        return res.status(403).end();
      }
    } catch {
      return res.status(500).end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Nudge intermediaries (Caddy/Nginx/etc.) to flush right away so the
    // browser's EventSource transitions to OPEN without waiting for the
    // first real event.
    try { res.write(`:ok\n\n`); } catch {}

    // Prefer the header (what EventSource sends automatically on retry)
    // but fall back to an explicit query arg for the first connect.
    const sinceSeq = req.headers['last-event-id'] || req.query.since || null;

    const write = (event) => {
      try {
        // `id:` makes EventSource remember this _seq and echo it back as
        // Last-Event-Id on reconnect, driving the ring-buffer replay.
        res.write(`id: ${event._seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    };

    const unsubscribe = sessionBus.subscribe(sessionId, write, sinceSeq);

    // Keep idle proxies/load balancers from dropping the connection.
    const hb = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 15000);

    const close = () => {
      clearInterval(hb);
      try { unsubscribe(); } catch {}
    };
    req.on('close', close);
    req.on('error', close);
  });

  // Get current user's budget
  router.get('/api/budget', async (req, res) => {
    // Staging mock data: the out-of-credits state (red meter + the
    // three-route credits banner + the in-chat card) is unreachable on a
    // staging preview without actually burning a real weekly allowance, so
    // a reviewer would only ever see the healthy state. ?demo=1 fabricates
    // an exhausted snapshot without touching the database — same idiom as
    // GET /api/me/ai-budget (routes/auth.js) and GET /api/me/cli-tokens.
    // Strictly a no-op in production. `demo: true` is what the client keys
    // its one-off card injection off (public/js/dev-chat.js).
    if (process.env.USERNODE_ENV === 'staging'
        && (req.query.demo === '1' || req.query.demo === 'weekly-out')) {
      // #2571: there is one allowance and one window now, so the two demo
      // spellings answer with the same fixture — ?demo=weekly-out is kept
      // only so existing review links and declared checks keep working.
      // The reset instant is computed inline rather than through the
      // weeklyResetAt() helper the real branch below uses: this branch must
      // stay provably free of any service call (tests/budget-demo.test.js
      // pins that), and next Monday 00:00 UTC is the same two lines either
      // way.
      const weekReset = new Date();
      weekReset.setUTCDate(weekReset.getUTCDate() + (((8 - weekReset.getUTCDay()) % 7) || 7));
      weekReset.setUTCHours(0, 0, 0, 0);
      return res.json({
        spentCents: 5000,
        limitCents: 5000,
        remainingCents: 0,
        creditPolicy: 'legacy',
        tier: 'legacy',
        limitSource: 'default',
        verificationRequired: false,
        entitlementAvailable: true,
        tierLimitCents: 1000,
        globalSpentCents: 4000,
        globalLimitCents: 100000,
        byokSpentCents: 0,
        aiEnabled: true,
        resetsAt: weekReset.toISOString(),
        lowBalancePct: 80,
        // #1788 stated which window these three figures describe; #2571
        // leaves only one answer.
        capWindow: 'weekly',
        windowLabel: 'This week',
        resetLabel: 'Monday 00:00 UTC',
        dailyApplies: false,
        dailyLimitCents: 2500,
        dailySpentCents: 900,
        weeklyApplies: true,
        weeklyLimitCents: 5000,
        weeklySpentCents: 5000,
        demo: true,
      });
    }
    try {
      const snapshot = await limits.getBudgetSnapshot(pool, req.user.id);
      const globalLimit = await limits.getGlobalLimitCents(pool);
      const { rows: globalRows } = await pool.query(
        'SELECT COALESCE(SUM(total_cost_cents), 0) AS total FROM llm_usage WHERE date = CURRENT_DATE'
      );
      const globalSpent = parseFloat(globalRows[0]?.total || 0);
      // #297: surface AI availability so client chrome (the proposal
      // "Explore in dev chat" pill) can disable itself with a tooltip when there's
      // no usable LLM path — the platform key is unset AND the user has
      // no BYOK key on file. Same degradation posture the dev chat takes.
      const userApiKey = await limits.loadUserApiKey(pool, req.user.id, config.dataEncryptionKey);
      res.json({
        ...snapshot,
        // #593: the two figures the composer's meter has to state out loud
        // — what is left, and when it comes back. Both were derivable from
        // the pair above plus a hardcoded "midnight UTC" on the client,
        // which is how the reset boundary ended up living in three places.
        globalSpentCents: globalSpent,
        globalLimitCents: globalLimit,
        // Keep the route's established spelling while the shared snapshot
        // uses `byokCents` internally.
        byokSpentCents: snapshot.byokCents,
        // Availability means a provider exists, not that this request has
        // allowance headroom. Keep the Explore/dev-chat entry points open so
        // their locked-tier UI can explain how to connect an identity.
        aiEnabled: llm.isEnabled() || !!userApiKey,
      });
    } catch (err) {
      log.error('sessions', 'Budget check failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Deploy staging for a session
  router.post('/api/sessions/:id/deploy-staging', drainGuard, async (req, res) => {
    try {
      // #183: headless rows are excluded — their staging is built by the
      // headless runner itself; humans deploy staging from a CLONED session.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url, a.id as app_id_val
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'promoted')
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];
      const app = { id: session.app_id_val, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

      // Get latest commit hash from the branch
      let commitHash = 'latest';
      if (github.isEnabled() && app.repo_url) {
        try {
          const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            // octokit.request, not .rest.git.getRef — @octokit/app's
            // installation Octokit lacks the rest-endpoint-methods
            // plugin. {+ref} preserves the `/` in `heads/<branch>`;
            // plain {ref} would percent-encode it and 404.
            const octokit = await github.getInstallationOctokit(owner);
            const { data: ref } = await octokit.request(
              'GET /repos/{owner}/{repo}/git/ref/{+ref}',
              { owner, repo, ref: `heads/${session.branch_name}` }
            );
            commitHash = ref.object.sha;
          }
        } catch {}
      }

      // Manual deployment can discover a newer branch head. Claim it before
      // entering the coordinator, but never regress a concurrently changed pin.
      if (require('../services/preview-lifecycle').enabled(config) && commitHash !== 'latest') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const claim = await client.query(`SELECT id FROM chat_sessions
            WHERE id = $1 AND checks_commit_sha IS NOT DISTINCT FROM $2::text
            FOR UPDATE`, [session.id, session.checks_commit_sha || null]);
          if (!claim.rows.length) throw require('../services/preview-lifecycle').cancelled();
          await visuals.setChecksPending(client, session.id, commitHash, 'building', 'manual-recheck');
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally { client.release(); }
      }

      // Build and deploy staging (async — respond immediately)
      res.json({ ok: true, status: 'deploying' });

      staging.buildAndDeployStaging(config, session, app, commitHash)
        .then(async (result) => {
          await pool.query(
            `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
            [result.containerId, result.stagingUrl, session.id]
          );
          // Verify the edge only after staging_url is persisted — that is
          // the point at which the hostname is a referenceable preview.
          await staging.verifyStagingEdge(session, result.hostname, result.stagingUrl);
          // #461: run the proposal checks against the fresh build, matching
          // every other staging-deploy path. Before this, a preview built
          // via this button left check_state NULL — the promote path then
          // skipped its own build+capture (staging_url already set) and the
          // proposal sat merge-blocked on "still running its tests" until a
          // sweep happened to heal it. Fire-and-forget; captureForSession
          // owns all failure handling and is _inFlight-guarded.
          visuals.captureForSession(config, session, app, commitHash === 'latest' ? null : commitHash, result, { send: null, trigger: 'manual-recheck' })
            .catch((err) => log.warn('visuals', 'Deploy-staging capture failed (non-fatal)', {
              sessionId: session.id, err: err.message,
            }));
        })
        .catch((err) => {
          log.error('sessions', 'Staging deploy failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('sessions', 'Deploy staging error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function loadPreviewSession(sessionId) {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1`,
      [sessionId]
    );
    return rows[0] || null;
  }

  function mayOpenPreview(session, userId, { mutate = false } = {}) {
    const isOwner = session.user_id === userId;
    const voteBacked = session.status === 'promoted' || session.status === 'merging';
    const shared = !!session.shared_at;
    // Reads use the router's view-level guard and may inspect a public vote
    // or explicitly shared session. A rebuild remains collab-gated by the
    // method-aware router guard; this predicate only scopes the row itself.
    return isOwner || voteBacked || shared || (!mutate && session.status === 'merged');
  }

  // One authoritative answer for both the owner's ensure-and-rebuild POST
  // and a read-only reviewer's status GET. A stored URL is only a pointer;
  // it is not evidence that the submitted revision is still what the runtime
  // serves. Verify revision/env/liveness, app health, then the public edge in
  // that order before anybody is allowed to navigate an iframe (#2328).
  async function inspectPreview(session, { repairDockerAlias = false } = {}) {
    const headSha = stagingRecovery.recheckHeadSha(session);
    if (await stagingRecovery.stagingNeedsRebuild(session, { config, headSha })) {
      return { status: 'missing' };
    }

    const stagingName = `usernode-staging-${session.app_slug}--${session.id}`;
    const runtimeKind = session.staging_runtime_kind || applicationRuntime.mode(config);
    if (repairDockerAlias && runtimeKind === 'docker') {
      await docker.ensureNetworkAlias(
        stagingName,
        applicationRuntime.dnsAlias({ environment: 'staging', sessionId: session.id })
      ).catch(() => false);
    }

    const healthy = await applicationRuntime.probeHealth(config, {
      runtimeKind,
      runtimeName: session.staging_runtime_name || (runtimeKind === 'docker' ? stagingName : null),
    }, { timeoutMs: 3000 }).catch(() => false);
    if (!healthy) {
      log.warn('sessions', 'preview runtime is live but did not answer its healthcheck', {
        sessionId: session.id, appSlug: session.app_slug,
      });
      return { status: 'unavailable', reason: 'unhealthy' };
    }

    let edgeRequired = false;
    let hostname = null;
    try {
      const url = new URL(session.staging_url);
      edgeRequired = url.protocol === 'https:';
      hostname = url.hostname;
    } catch (_) {
      return { status: 'unavailable', reason: 'edge' };
    }
    if (edgeRequired) {
      const edge = await staging.verifyStagingEdge(session, hostname, session.staging_url)
        .catch(() => ({ ok: false }));
      if (!edge?.ok) return { status: 'unavailable', reason: 'edge' };
    }

    return {
      status: 'ready', url: session.staging_url, verified: true,
      checksRunning: session.check_state === 'pending',
    };
  }

  // Read-only twin of ensure-staging. A reviewer who cannot trigger a build
  // still gets the same health/revision/edge gate instead of opening the
  // last stored URL directly. It never repairs, rebuilds, or changes state.
  router.get('/api/sessions/:id/preview-status', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const session = await loadPreviewSession(sessionId);
      if (!session || !mayOpenPreview(session, req.user.id)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }
      const result = await inspectPreview(session);
      return res.json(result.status === 'missing'
        ? { status: 'unavailable', reason: 'missing' }
        : result);
    } catch (err) {
      log.error('sessions', 'preview-status error', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // On-demand staging restore (#439). The Preview button calls this before
  // opening the overlay. When the preview is already live we tell the
  // client to open it as-is; when it was torn down (idle GC, lost
  // container) we kick off a rebuild from the branch's latest commit and
  // let rebuildSessionStaging's existing `staging_ready` broadcast drive
  // the front end's "spinning back up" loader to completion.
  //
  // The sessionCollabGuard above already gates this to app members; the
  // ownership check below scopes WHO may trigger a rebuild.
  router.post('/api/sessions/:id/ensure-staging', drainGuard, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const session = await loadPreviewSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      // Authorize: the session owner always; for promoted/merging sessions
      // (whose preview backs a group vote) any app member who passed the
      // collab guard may trigger a rebuild, matching the vote panel showing
      // them the Preview button. Explicitly-shared sessions (shared_at set
      // — their card shows everyone a Preview button too) get the same
      // member-wide access.
      if (!mayOpenPreview(session, req.user.id, { mutate: true })) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      // Staging containers have no Docker socket (SELF-HOSTING.md Phase 2g)
      // and cannot build nested previews. Short-circuit so a Preview click
      // inside a staging preview of this platform shows a friendly message
      // instead of spinning forever on a rebuild that can never run.
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }

      // A missing/stale runtime rebuilds. A present but unhealthy one is
      // reported honestly and left alone: one failed bounded probe is not a
      // reason to churn the app or its database, but it is a reason not to
      // navigate the reviewer to stale/current/error content.
      const inspected = await inspectPreview(session, { repairDockerAlias: true });
      if (inspected.status !== 'missing') return res.json(inspected);

      // Dedup concurrent clicks: at most one rebuild per session in flight.
      if (ensureStagingInFlight.has(sessionId)) {
        return res.json({ status: 'rebuilding' });
      }
      ensureStagingInFlight.add(sessionId);
      res.json({ status: 'rebuilding' });

      // Fire-and-forget. On success rebuildSessionStaging broadcasts
      // `staging_ready` with the (new, commit-hash-bearing) URL, which the
      // front end opens. On a no-op ('skipped' — branch not ahead of main)
      // or a build failure (missing secrets, docker error) we broadcast
      // `staging_failed` so the loader surfaces a concrete reason.
      const { broadcastGlobal } = require('../services/ws');
      stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'preview-click' })
        .then((result) => {
          if (result === 'skipped') {
            broadcastGlobal({
              type: 'session_event', sessionId,
              event: 'staging_failed',
              error: 'This branch has no changes to preview yet.',
              errorName: 'NothingToPreview',
              missingKeys: [],
            });
          }
        })
        .catch((err) => {
          const { errMsg, errName, missingKeys } = describeStagingFailure(err);
          log.error('sessions', 'ensure-staging rebuild failed', {
            sessionId, errName, err: errMsg, missingKeys,
          });
          broadcastGlobal({
            type: 'session_event', sessionId,
            event: 'staging_failed',
            error: errMsg, errorName: errName, missingKeys,
          });
        })
        .finally(() => {
          ensureStagingInFlight.delete(sessionId);
        });
    } catch (err) {
      log.error('sessions', 'ensure-staging error', { message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #447: manual "Re-run checks" for a proposal whose automated checks are
  // stuck. Before this the only way out of a stuck 'pending'/NULL verdict was
  // the owner pushing a brand-new commit — useless for an already-correct PR
  // whose build succeeded — or an admin force-merge that skips checks
  // entirely. This re-runs the checks: rebuild staging if the preview is
  // gone, else re-run against the live container. Progress flows through the
  // existing checks_ready / staging_ready broadcasts so the badge updates in
  // place. Owner + admins only.
  router.post('/api/sessions/:id/recheck', drainGuard, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];

      // Pausing stops coding; explicit verification of existing work remains open.
      if (!['active', 'paused', 'promoted'].includes(session.status)) {
        return res.status(409).json({
          error: 'proposal_closed',
          message: `This proposal is ${session.status || 'no longer open'}, so its checks cannot be re-run.`,
        });
      }

      // Owner or admin only — re-running checks costs a staging build +
      // headless run, so it's not opened to every collaborator (deferred).
      // NB: req.user is the camelCase shape from middleware/auth.js —
      // `is_admin` doesn't exist on it, and checking it meant admins were
      // 403'd on every proposal they didn't own (surfaced by the campaign
      // dashboard, whose sessions belong to usernode-platform). Rechecks
      // mutate check state and cost a build, so gate on canAdminWrite
      // (excludes read-only admins), matching the dashboard's CAN_WRITE.
      const isOwner = session.user_id === req.user.id;
      if (!isOwner && !req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      // Staging containers can't build nested previews (no Docker socket),
      // so a recheck can never run inside a staging preview of the platform.
      if (process.env.USERNODE_ENV === 'staging') {
        return res.json({ status: 'unavailable', reason: 'demo' });
      }

      // Coalesce repeat clicks.
      if (recheckInFlight.has(sessionId)) {
        return res.json({ status: 'running' });
      }
      // A local proposal submission holds a non-worker session operation
      // through staging + capture. Starting a manual recheck inside that
      // window would queue a second capture that can outlive the operation
      // claim and overlap the next web coding turn. Treat every existing
      // session-owned pipeline as the run the user is trying to request.
      if (isSessionBusy(sessionId)
          || staging.hasInFlightBuild(sessionId)
          || visuals.hasInFlightCapture(sessionId)) {
        return res.json({ status: 'running' });
      }
      recheckInFlight.add(sessionId);

      // #607: stamp 'pending' + broadcast BEFORE responding so the client's
      // immediate refresh deterministically sees the in-progress state (the
      // fire-and-forget below re-stamps idempotently — same commit sha, so
      // the failure-streak bookkeeping is preserved).
      const visualsService = require('../services/visuals');
      await visualsService.setChecksPending(pool, sessionId, session.checks_commit_sha || null, 'building', 'manual-recheck')
        .catch((err) => log.warn('sessions', 'recheck setChecksPending failed (non-fatal)', {
          sessionId, err: err.message,
        }));
      visualsService.notifyChecksPending(sessionId, session.checks_commit_sha || null, 'building', 'manual-recheck');

      res.json({ status: 'running', checkState: 'pending' });

      // Fire-and-forget. recheckSessionChecks rebuilds staging when the
      // preview is missing (the rebuild re-runs the checks) or re-runs the
      // checks directly against the live container otherwise. All progress +
      // failure surfacing rides the existing capture/broadcast paths.
      stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'manual-recheck' })
        .catch((err) => {
          log.error('sessions', 'manual recheck failed', { sessionId, err: err.message });
        })
        .finally(() => {
          recheckInFlight.delete(sessionId);
        });
    } catch (err) {
      log.error('sessions', 'recheck error', { message: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Thin alias so existing in-file callers keep working unchanged.
// New callers (conflict-resolver, etc.) should `require('../services/limits')`
// directly and call `limits.checkBudget(pool, userId)`.
async function checkBudget(pool, userId) {
  return limits.checkBudget(pool, userId);
}

// The BYOK key lookup that used to live here (loadUserApiKey) moved to
// services/limits.js (#212) — every call site now goes through
// limits.resolveBillingPath, which consumes the daily allowance first
// and only reaches for the key once the budget is exhausted.

// #155: the follow-up assistant message appended to a session cloned from a
// headless auto session — tells the new owner where the auto run left off
// (spec to review / code done / question pending) and that PR + staging are
// theirs to trigger.
function buildHeadlessFollowUpMessage(src) {
  const n = src.headless_issue_number;
  const issueRef = n ? `GitHub issue #${n}` : 'a GitHub issue';
  const intro =
    `This session was cloned from an auto session that ran unattended on ${issueRef}. `
    + `You're on your own branch (forked from the auto session's, so its commits carry over). `
    + `other users can clone the same auto session independently without affecting yours.`;
  switch (src.headless_outcome) {
    case 'spec':
      return `${intro}\n\nWhere things stand: the auto session investigated the repo and drafted a spec. Open the spec viewer to review it. When you're happy with it, tell me to build it and I'll dispatch the coding agent (that turn also opens the PR and staging preview).`;
    case 'code':
      return `${intro}\n\nWhere things stand: the code change is already committed and pushed on this branch. See the "Changes ready" card above. A staging preview may be shown there ("Preview staging" / "Test this change") if one built; if it didn't, the card still lets you propose and the preview is rebuilt then. No PR exists yet. Review the change, iterate if you want, and when you're ready hit "Propose to group" on the card, which opens the PR on this branch and starts the vote (or just ask me).`;
    case 'spec_code':
      return `${intro}\n\nWhere things stand: the auto session drafted a spec (open the spec viewer to review it) AND implemented it: the change is committed and pushed on this branch. See the "Changes ready" card above; a staging preview may be shown there if one built, and either way the card lets you propose (the preview is rebuilt at propose time if needed). No PR exists yet. Review the spec and the change, iterate if you want, and when you're ready hit "Propose to group" on the card, which opens the PR on this branch and starts the vote (or just ask me).`;
    default:
      return `${intro}\n\nWhere things stand: the auto session ran into something that needs a human decision. See its last message above (the same questions were also posted as a comment on the GitHub issue). Answer here and we'll continue from where it left off.${(src.spec_md || '').trim() ? ' The auto session also drafted a spec, so open the spec viewer to review it alongside the questions.' : ''}`;
  }
}

// #330: next-step quick-reply pills for the cloned follow-up message. The
// auto-session clone produces no Mayor turn, so the follow-up would
// otherwise land with an empty pill bar — leaving the user told to "build
// it" with nothing to tap. Attach static, outcome-appropriate pills so the
// above-box pill row is populated from the first screen. The 'question'
// outcome returns null: it already forwards the question turn's answer
// chips, and pills are mutually exclusive with chips (answers win). Routed
// through sanitizeQuickReplies to keep the ≤3 / ≤80-char invariant shared
// with the Mayor's suggest_replies path.
function buildHeadlessFollowUpQuickReplies(src) {
  let replies;
  switch (src.headless_outcome) {
    case 'spec':
      // #1046: mirrors RECOVERY_PILLS.spec_done — the build pill names the
      // whole spec, not one component of it.
      replies = ['Build the spec', 'Revise the spec', 'What will this change?'];
      break;
    case 'code':
      replies = ['Propose it to the group', 'Make a tweak', 'What did it change?'];
      break;
    case 'spec_code':
      replies = ['Propose it to the group', 'Revise the spec', 'Make a tweak'];
      break;
    default:
      return null;
  }
  return sanitizeQuickReplies({ replies });
}

// The unattended-mode addendum appended to the Mayor system prompt for
// both headless phases. Factored out so the boot-time resume path
// (resumeHeadlessRuns) can rebuild the exact same prompt.
function buildHeadlessAddendum(issueNumber) {
  return `

HEADLESS AUTO-SESSION MODE: you are running unattended on GitHub issue #${issueNumber} — there is NO human in this chat and there will be NO follow-up turn. Decide ONE action for this single turn, in this order:
1. FIRST apply the CLARITY GATE (above) to the issue, including any ISSUE COMMENTS included in the message — treat the reporter's comments as their input, and comments marked as earlier proposal questions as your own previous turn (answers to them may make the issue clear now). If the issue FAILS the gate, classify each blocking question you would ask:
   - REPO-ANSWERABLE: what exists in the app, where the relevant code lives, how a feature currently behaves, whether the report matches reality. Asking the reporter is a last resort — investigation comes first: these questions go to dispatch_scout (step 2), NOT to the reporter. In the scout prompt, enumerate the unresolved points and instruct it to settle them from the code, choose stated defaults where reasonable, and keep only the genuinely human-only blockers in a "Questions" section.
   - HUMAN-ONLY: what the reporter wants, product/priority choices, reproduction details only the reporter has — things no codebase can answer.
   ONLY if EVERY blocking question is human-only: reply in plain text containing ONLY the numbered clarifying questions with your suggested defaults, AND ALSO call suggest_answers for those questions. The suggest_answers call is metadata-only — it does NOT change the verbatim text posted to GitHub issue #${issueNumber}; it exists so the human who later starts a session from this proposal can tap the suggested answers. The visible text must still be ONLY the numbered questions with defaults. Your text reply will be posted verbatim as a comment on GitHub issue #${issueNumber} for the reporter to answer — write it for them (no greetings, no meta-talk about sessions or tools). Otherwise dispatch_scout per step 2.
2. dispatch_scout when the issue passes the gate and needs investigation or design — OR when the gate failed for repo-answerable reasons (scouting is also the way to resolve ambiguity): produce a grounded spec a human will review later. Prefer this for anything non-trivial. After the scout returns you will get ONE follow-up decision turn where you may implement the spec immediately if it turned out straightforward — so scouting first never costs you the chance to ship; any questions surviving the scout's investigation will be posted to the issue from that decision turn, so failing the gate is not a reason to avoid scouting.
3. dispatch_claude_code ONLY for small, unambiguous fixes the issue text fully specifies. The agent may commit and push its branch, and a staging preview is built from the pushed commit — but NO pull request is created in this mode; a human will start a session from this auto session later and propose the change (which opens the PR on their branch).
Never promise future work and never ask for confirmation — state what you did and what the human reviewer should do next.
${SCREENSHOT_FETCH_NOTE}`;
}

// #683: issue bodies can embed a reporter-captured screenshot as a
// markdown image on the platform's public /issue-images/:id route.
// Mirrors the usernode-attachments image instruction (services/
// attachments.js buildDispatchBlock): the worker has curl + outbound
// network, and Claude Code's Read tool views local image files. Appended
// to the headless addendum and both worker prompts (scout + build).
// #2779: the coding agent's read-only platform tools, served by
// worker/homeroom-read-mcp.js on a grant execInWorker issues per build or
// scout turn (services/worker.js mintHomeroomReadGrant). Minting is best
// effort, so the note says what to do when they are absent.
const HOMEROOM_READ_NOTE = 'Read-only Homeroom tools may also be available to you, as the MCP server `homeroom`: get_platform_conventions, get_app, list_requests, get_request, get_proposal and get_change. They read what the platform knows about THIS change\'s app: a section of the platform conventions on demand, the full discussion on a request, a proposal and its check results. They cannot write anything, and a call about any other app is refused. If they are not in your tool list this turn, carry on without them. Questions for the user still go in your final message.';

const SCREENSHOT_FETCH_NOTE = 'If the issue body embeds a screenshot URL like `https://…/issue-images/<id>` (a **Screenshot:** image line), it is a screenshot the reporter captured as context — the agent working the issue should download it with `curl -sS -o /tmp/issue-screenshot.png <url>` (run via Bash) and use its Read tool on /tmp/issue-screenshot.png to view it before working.';

// #170: the addendum for the headless DECISION turn — the one extra Mayor
// call offered after a successful scout, where the run may proceed straight
// into implementation if (and only if) the spec is straightforward. The
// criteria live here in prompt text so they're tunable without flow
// changes; the hard limits (one build max, budget re-check, no PR/staging)
// are enforced in code in runHeadlessSession.
function buildHeadlessDecisionAddendum(issueNumber) {
  return `

DECISION TURN: the scout's spec is now in your system prompt (CURRENT SPEC DOC). You get exactly ONE more action.
If the spec contains a Questions section with decisions a human must make: do NOT dispatch. Reply in plain text containing ONLY those numbered questions with your suggested defaults, written for the issue reporter, AND ALSO call suggest_answers for those questions. The suggest_answers call is metadata-only — it does NOT change the verbatim text posted to GitHub issue #${issueNumber}; it exists so the human who later starts a session from this proposal can tap the suggested answers. The visible text must still be ONLY the numbered questions with defaults. Your text reply will be posted verbatim as a comment on GitHub issue #${issueNumber} (no greetings, no meta-talk about sessions or specs).
Otherwise, dispatch dispatch_claude_code to implement the spec NOW only if ALL of these hold:
- The spec has no **unresolved/blocking** questions — a "Questions" section that says "None" (or is empty) is NOT a blocker; proceed to build it. Only an open question that genuinely requires a human decision blocks the build.
- It describes a small, bounded change with concrete file paths — roughly a handful of files, no broad refactor.
- Database schema changes are allowed ONLY when they are append-only and forward-only: creating new tables (\`CREATE TABLE IF NOT EXISTS\`), adding new nullable columns (\`ADD COLUMN IF NOT EXISTS\`), and forward-only data backfills. Drops, renames, type changes, not-null tightenings, and any other destructive or irreversible database operation are NOT allowed — defer to a human when in doubt. Also no other destructive or irreversible operations, and no changes to auth, billing, permissions, or security-sensitive code.
- No new external services, dependencies, or credentials.
- The spec stays within what issue #${issueNumber} asked for (no scope expansion).
If ANY criterion fails or you are unsure, reply in plain text instead — summarize the spec and stop; a human will review it. When you do dispatch, the prompt must tell the agent to implement the session's spec doc exactly as written and not redesign it. Remember: headless mode means commit + push + staging preview — no PR.`;
}

// #150: build the headless run's seed user message from the issue plus
// its comments, so answers the reporter left as comments are visible to
// the run. Comments authored by the platform bot are tagged so the Mayor
// recognizes its own earlier clarifying questions vs. the reporter's
// answers. Each comment body is truncated and only the most recent
// HEADLESS_SEED_MAX_COMMENTS are kept (with an omission marker), so a
// chatty thread can't blow up the model's context. Exported for tests.
const HEADLESS_SEED_MAX_COMMENTS = 20;
const HEADLESS_SEED_COMMENT_MAX_CHARS = 2000;
function buildHeadlessSeed(issueNumber, issue, comments, botUsername, threadMessages = []) {
  const title = issue ? issue.title : '';
  const body = issue && issue.body ? `\n\n${issue.body}` : '';
  let seed = `Please work on GitHub issue #${issueNumber}: "${title}".${body}`;

  const list = Array.isArray(comments) ? comments : [];
  const thread = Array.isArray(threadMessages) ? threadMessages : [];
  // Nothing on either surface → the seed stays exactly what it has always
  // been (pinned by tests/headless-clarify.test.js).
  if (!list.length && !thread.length) return seed;

  // GitHub comments keep their own most-recent-N cap and per-comment clip;
  // the Homeroom half arrives already clipped by thread-context.
  const kept = list.slice(-HEADLESS_SEED_MAX_COMMENTS);
  const clippedGithub = kept.map((c) => ({
    author: (c.author || 'unknown').toString(),
    body: (c.body || '').toString().length > HEADLESS_SEED_COMMENT_MAX_CHARS
      ? `${(c.body || '').toString().slice(0, HEADLESS_SEED_COMMENT_MAX_CHARS)}… [truncated]`
      : (c.body || '').toString(),
    createdAt: c.createdAt || '',
  }));

  seed += `\n\n${threadContext.buildIssueDiscussionBlock({
    issueNumber,
    githubComments: clippedGithub,
    threadMessages: thread,
    botUsername,
    truncated: list.length > kept.length,
  })}`;
  return seed;
}

// #150: gate for posting phase-1 question text back to the GitHub issue.
// Only a PURE-TEXT phase-1 turn qualifies: the dispatch-error path also
// ends outcome='question' but its text is an error summary, not
// questions for the reporter. Exported for tests.
function shouldPostHeadlessQuestionComment({ outcome, dispatchedTool, mayorText }) {
  return outcome === 'question' && !dispatchedTool && !!(mayorText || '').trim();
}

// #178/#196: does the spec still carry a blocking "Questions" section after
// the scout's investigation? Keys on ATX headings whose text begins with
// "Question(s)" / "Open question(s)" — the exact section name the base
// prompt and scout prompt mandate for blockers — then INSPECTS the section
// body: a heading whose body is empty or only a "nothing here" marker
// ("None", "N/A", …) is NOT a blocker, so a scout's habitual
// "### Questions\nNone" no longer parks the run for a human. Only a section
// with real residual content (a list item or sentence) blocks. A false
// positive merely downgrades a buildable spec to a posted-questions
// round-trip; a false negative reproduces the old park-for-human behavior.
// Exported for tests.
//
// Recognized "nothing here" markers (case-insensitive, tolerating trailing
// punctuation and a short trailing clause like "None — resolved from code.").
const QUESTIONS_EMPTY_MARKER_RE = /^(?:none|n\/a|na|no\s+open\s+questions|no\s+questions|no\s+blocking\s+questions|none\s+blocking|nothing\s+blocking)\b/i;

function specHasBlockingQuestions(specMd) {
  const text = specMd || '';
  // Match a Questions-style ATX heading, capturing its level (# count) so we
  // can find where its section ends (next same-or-higher-level heading).
  const headingRe = /^(#{1,6})\s*(?:open\s+)?questions?\b[^\n]*$/gim;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const level = m[1].length;
    const bodyStart = m.index + m[0].length;
    // Find the next heading whose level is <= this section's level (a sibling
    // or higher heading); deeper sub-headings stay part of the section.
    const rest = text.slice(bodyStart);
    const stopRe = /^(#{1,6})\s/gm;
    let stop;
    let bodyEnd = rest.length;
    while ((stop = stopRe.exec(rest)) !== null) {
      if (stop[1].length <= level) { bodyEnd = stop.index; break; }
    }
    const body = rest.slice(0, bodyEnd);
    if (questionsBodyHasContent(body)) return true;
  }
  return false;
}

// Strip markdown noise from a Questions section body and decide whether it
// carries a real question (vs. empty or a "None"-style marker).
function questionsBodyHasContent(body) {
  const cleaned = (body || '')
    .split('\n')
    .map((line) => line
      // drop leading list/quote markers
      .replace(/^\s*(?:[-*>]\s*)+/, '')
      // drop emphasis underscores/asterisks anywhere
      .replace(/[_*]/g, '')
      .trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  if (!cleaned) return false;
  if (QUESTIONS_EMPTY_MARKER_RE.test(cleaned)) return false;
  return true;
}

// #1959: is a session WAITING ON ITS OWNER? The one verdict behind the
// Improve panel's "Ready for your input" pill (GET /api/me/active-sessions
// ships it as `awaiting_input`), so the panel never claims a session needs
// input when nothing in it is asking.
//
// The transcript already knows. Two things in it are a question the user
// has not answered, and the row ends up here only if the LAST conversational
// row (user or assistant — the same rows DevChat._qaCurrentGroups walks) is
// the assistant's: once the owner has replied it is their turn that is
// pending, not the assistant's question.
//
//   1. ANSWER CHIPS. The assistant asked with suggest_answers (#32) and the
//      chips are still on screen — `metadata.suggestions` on that last row,
//      the same key the clone path forwards. This is what an auto session
//      that ended in a question looks like once it is cloned.
//   2. A SPEC WITH OPEN QUESTIONS. The scout drafted a spec whose Questions
//      section still has content (specHasBlockingQuestions — the parser the
//      headless path uses to refuse a build). Only while nothing has been
//      built from it: a session with a pull request is past its spec, which
//      is the precedence fallbackKindForTurn already gives a PR over a spec,
//      and without it a spec built despite its questions would read as
//      waiting for the rest of the session's life.
//
// A turn in flight is never waiting on anyone; the client gates on its live
// busy state, so this only has to be right for an idle row.
function sessionAwaitsInput({ lastTurnRole, lastTurnAsks, prNumber, specMd }) {
  if (lastTurnRole !== 'assistant') return false;
  if (lastTurnAsks === true) return true;
  if (prNumber) return false;
  return specHasBlockingQuestions(specMd);
}

const HEADLESS_QUESTION_FOOTER = '\n\nPosted by this issue\'s proposal session. '
  + 'Answer in a comment (or edit the issue body), then press **Generate proposal** on the issue again: the next run reads the answers.';

// #945: the same footer for the platform-side dual-post. Reading is now
// symmetric (a run reads both the GitHub comments and this thread), so the
// wording points at whichever surface the reader is already looking at.
const HEADLESS_QUESTION_THREAD_FOOTER = '\n\nPosted by this issue\'s proposal session. '
  + 'Answer right here in this thread (or on the GitHub issue), then press **Generate proposal** on the issue again: the next run reads both.';

// Best-effort: a failed post must never fail or change the run's outcome
// (the parked session remains the fallback channel). Returns whether the
// comment landed so the caller can decide whether to surface a status.
async function postHeadlessQuestionComment({ repoOwner, repoName, issueNumber, questionText }) {
  try {
    await github.createIssueComment(repoOwner, repoName, issueNumber, questionText + HEADLESS_QUESTION_FOOTER);
    return true;
  } catch (err) {
    log.warn('sessions', 'Failed to post clarifying questions to issue (continuing)', {
      issueNumber, err: err.message,
    });
    return false;
  }
}

// #945: dual-post the same clarifying questions into the issue's
// platform-side Discussion thread, so the questions appear on the surface
// most people are actually looking at — and where their answers are now
// read back from. Mirrors the dual-post convention in routes/issues.js
// (system row, no author, scoped to { type: 'issue', ref }).
//
// Best-effort in exactly the same way as the GitHub post above: a failure
// is logged and swallowed, never changing the run's terminal state.
async function postHeadlessQuestionThreadMessage({ pool, appId, issueNumber, questionText }) {
  try {
    const { sendSystemMessage } = require('../services/ws');
    await sendSystemMessage(
      pool, appId, questionText + HEADLESS_QUESTION_THREAD_FOOTER,
      'system', null, { type: 'issue', ref: issueNumber }
    );
    return true;
  } catch (err) {
    log.warn('sessions', 'Failed to post clarifying questions to the issue thread (continuing)', {
      issueNumber, err: err.message,
    });
    return false;
  }
}

// Persist where the headless loop currently is so a platform restart can
// resume from the last checkpoint instead of failing the run. Steps:
// 'planning' (Mayor phase-1) → 'cc_running' (CC turn dispatched) →
// 'wrapping' (Mayor phase-2). `outcome` is persisted alongside the
// cc_running → wrapping transition so a 'wrapping' resume knows what the
// dispatch arrived at without re-deriving it.
async function setHeadlessStep(pool, sessionId, step, outcome, headlessTurnId = undefined) {
  const sets = ['headless_step = $1'];
  const params = [step, sessionId];
  if (outcome !== undefined) {
    params.push(outcome);
    sets.push(`headless_outcome = $${params.length}`);
  }
  if (headlessTurnId !== undefined) {
    params.push(headlessTurnId);
    sets.push(`headless_turn_id = $${params.length}`);
  } else if (step === 'planning') {
    sets.push('headless_turn_id = NULL');
  }
  // This is a dispatch/replay boundary, not telemetry. If it cannot commit,
  // the caller must not make the next paid call under an identity recovery
  // cannot rediscover.
  await pool.query(
    `UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = $2`,
    params,
  );
}

async function checkpointHeadlessWrapUp(pool, sessionId, outcome) {
  const headlessTurnId = crypto.randomUUID();
  await setHeadlessStep(pool, sessionId, 'wrapping', outcome, headlessTurnId);
  return headlessTurnId;
}

// #155: the unattended Mayor turn behind the issue panel's "Generate
// proposal" button. Mirrors one POST /chat turn (phase-1 Mayor + optional dispatch +
// phase-2 wrap-up) with three deliberate differences: there is no SSE
// stream (events go to the session bus / global WS only), there is no stop
// handle (nobody is watching), and a build dispatch runs with
// `headless: true` so it can push its branch and build a staging preview
// (#183) but never opens a PR. All spend is billed to the clicking user. On success the
// session flips to headless_status='ready' with an outcome of 'spec'
// (scout drafted a spec), 'code' (commit pushed), 'spec_code' (#170 — scout
// drafted a spec AND the decision turn implemented it), or 'question' (the
// Mayor replied in text / the dispatch errored — either way a human needs
// to look).
//
// #170: after a SUCCESSFUL scout, phase-2 becomes a DECISION turn — the
// Mayor sees the spec in its system prompt and may dispatch one (and only
// one) headless build when the spec is straightforward, followed by a
// tool-less phase-3 wrap-up. Every other path keeps the original tool-less
// phase-2 wrap-up.
//
// `resume` is set by resumeHeadlessRuns when re-driving a 'planning'-step
// run after a restart: the seed user message already exists in
// chat_session_messages, so it isn't inserted again.

// #1001: metadata for a headless run's FINAL assistant row.
//
// Every headless wrap-up persist used to write no metadata at all, so all 94
// headless sessions measured in production resolved to the client's built-in
// generic default. They get the deterministic set here rather than a model
// call: nobody reads an auto session's pill bar until it is cloned, and the
// CLONE path is where the assistant authors pills from the run's actual
// output (see the clone follow-up). Pill-free when answer chips are present —
// chips win over the above-box row everywhere.
function headlessWrapUpMeta(outcome, { suggestions = null } = {}) {
  if (Array.isArray(suggestions) && suggestions.length) return { suggestions };
  const kind = outcome === 'spec'
    ? 'spec_done'
    : (outcome === 'code' || outcome === 'spec_code')
      ? 'code_done'
      : outcome === 'question' ? null : 'turn_failed';
  if (!kind) return {};
  const replies = buildRecoveryQuickReplies(kind);
  if (!replies) return {};
  return { quickReplies: replies, quickRepliesSource: 'static', quickRepliesKind: kind };
}

async function runHeadlessMayorEffect({
  pool, sessionId, headlessTurnId, invoke, fallbackText, allowInvoke = true,
}) {
  const fallback = {
    ...snapshotMayorResponse({ text: fallbackText }),
    recoveryFallback: true,
  };
  if (!headlessTurnId) {
    return {
      response: allowInvoke ? snapshotMayorResponse(await invoke()) : fallback,
      disposition: allowInvoke ? 'legacy' : 'skipped',
    };
  }
  const effect = await turnEffects.runExternalEffectFailClosed({
    pool,
    turnId: headlessTurnId,
    effectKey: HEADLESS_WRAPUP_EFFECT_KEYS.llm,
    sessionId,
    // Recording the deterministic fallback as the completed effect keeps
    // restart recovery idempotent without issuing a provider request when
    // the current billing decision has no payer.
    run: async () => (allowInvoke ? snapshotMayorResponse(await invoke()) : fallback),
    fallback,
  });
  return {
    response: effect.value || fallback,
    disposition: effect.disposition,
  };
}

async function persistHeadlessMayorRow({
  pool, sessionId, headlessTurnId, text, model, usage, costCents, metadata,
}) {
  const params = [
    sessionId,
    text,
    model || null,
    usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : 0,
    costCents || 0,
    JSON.stringify(metadata || {}),
  ];
  const insert = (client) => client.query(
    `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
     VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
    params,
  );
  if (!headlessTurnId) {
    await insert(pool);
    return true;
  }
  const receipt = await turnEffects.runDbEffect({
    pool,
    turnId: headlessTurnId,
    effectKey: HEADLESS_WRAPUP_EFFECT_KEYS.message,
    sessionId,
    run: async (client) => {
      await insert(client);
      return { persisted: true };
    },
  });
  return receipt.applied;
}

async function settleHeadlessMayorUsage({
  pool, userId, sessionId, headlessTurnId, usage, servedModel,
  selectedModel, userApiKey, emit = null,
}) {
  if (!usage) return 0;
  const billModel = servedModel || selectedModel;
  const costCents = llm.estimateCostCents(usage, billModel);
  if (costCents) {
    if (headlessTurnId) {
      await limits.settleTurnSpend(pool, userId, costCents, {
        turnByok: !!userApiKey,
        turnId: headlessTurnId,
        sessionId,
        effectKey: HEADLESS_WRAPUP_EFFECT_KEYS.spend,
      });
    } else {
      await limits.recordSpend(pool, userId, costCents, { byok: !!userApiKey });
    }
  }
  if (typeof emit === 'function') {
    emit('usage', { costCents, model: billModel, byok: !!userApiKey });
  }
  return costCents;
}

async function runHeadlessSession({
  pool, config, session, user, selectedModel,
  repoOwner, repoName, userApiKey, issueNumber, issue,
  comments = [], botUsername = null,
  resume = false,
}) {
  const { broadcastGlobal } = require('../services/ws');
  const seqPrefix = `h${Date.now().toString(36)}`;
  let eventSeq = 0;
  const send = (type, data) => {
    const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, ...data };
    // #437: spread the event FIRST, then pin the envelope — otherwise
    // `...event` re-adds the inner `type` and clobbers `type: 'session_event'`,
    // so the client's `switch (data.type)` never reaches handleSessionEvent.
    // Headless sessions have no POST SSE (res is a write-sink), so the global
    // WS is their ONLY live channel — the clobber is especially costly here.
    broadcastGlobal({ ...event, sessionId: session.id, event: type, type: 'session_event' });
    sessionBus.publish(session.id, event);
  };
  const sendStatus = async (text, metadata) => {
    send('status', { text, ...(metadata || {}) });
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [session.id, text, JSON.stringify(metadata || {})]
    ).catch(() => {});
  };
  // The dispatch helpers (runScoutTool / runClaudeCodeTool) use `req` only
  // for billing identity (+ PR author, unused in headless) and `res` only
  // for SSE heartbeats — substitute the clicking user and a write-sink.
  const fakeReq = { user: { id: user.id, username: user.username } };
  const fakeRes = { write() {} };

  const debitMayorUsage = async (usage, servedModel) => {
    if (!usage) return;
    const billModel = servedModel || selectedModel;
    const cost = llm.estimateCostCents(usage, billModel);
    await limits.recordSpend(pool, user.id, cost, { byok: !!userApiKey });
    send('usage', { costCents: cost, model: billModel, byok: !!userApiKey });
    return cost;
  };

  const resolveHeadlessPayer = async (phase) => {
    try {
      const billing = await limits.resolveBillingPath(
        pool, config.dataEncryptionKey, user.id,
      );
      if (!billing.error) {
        userApiKey = billing.apiKey;
        return true;
      }
      log.info('sessions', 'Headless model phase skipped: no payer available', {
        sessionId: session.id, phase, reason: billing.reason || null,
      });
    } catch (err) {
      log.warn('sessions', 'Headless billing re-resolve failed', {
        sessionId: session.id, phase, err: err.message,
      });
    }
    return false;
  };

  // Fable 5 classifier fallback: same once-per-run notice + per-call
  // admin record as the interactive chat handler.
  let fallbackNoticed = false;
  const noteModelFallback = async (result) => {
    if (!result || !result.fallbackServed) return;
    const requested = selectedModel;
    const served = result.servedModel;
    const category = (result.stopDetails && result.stopDetails.category) || null;
    await modelFallback.record(pool, {
      kind: events.EVENT_TYPES.MODEL_FALLBACK,
      userId: user.id, appId: session.app_id, sessionId: session.id,
      requested, served, category, source: 'headless',
    });
    if (!fallbackNoticed) {
      fallbackNoticed = true;
      await sendStatus(modelFallback.noticeText(requested, served, category), {
        modelFallback: { requested, served, category },
      });
    }
  };

  let outcome = 'question';
  // Stable receipt identity for the next/current post-agent Mayor phase.
  // It is checkpointed before the coding turn is released, then replaced
  // when a scout decision legitimately starts a later build wrap-up.
  let headlessTurnId = null;
  // #178: the reporter-facing question text to post on the issue at the
  // terminal write, set by whichever path produced it — the phase-1
  // pure-text turn, or the decision turn when the scout's spec still
  // carries a blocking Questions section. Empty means nothing to post.
  let questionTextToPost = '';
  const finalizeReady = async () => {
    await pool.query(
      `UPDATE chat_sessions SET headless_status = 'ready', headless_outcome = $1,
              headless_step = NULL, headless_turn_id = NULL, last_activity_at = NOW()
       WHERE id = $2`,
      [outcome, session.id]
    );
    send('headless_update', { status: 'ready', outcome, issueNumber, appSlug: session.app_slug });
    sessionState.touch(session.id);
    if (questionTextToPost) {
      const posted = await postHeadlessQuestionComment({
        repoOwner, repoName, issueNumber, questionText: questionTextToPost,
      });
      const threadPosted = await postHeadlessQuestionThreadMessage({
        pool, appId: session.app_id, issueNumber, questionText: questionTextToPost,
      });
      if (posted || threadPosted) {
        await sendStatus(`Posted clarifying questions to issue #${issueNumber}`);
      }
    }
    await notifyAutoSolveDone(pool, {
      userId: user.id, appId: session.app_id, sessionId: session.id, detail: outcome,
    });
    log.info('sessions', 'Headless session ready', { sessionId: session.id, issueNumber, outcome });
  };
  try {
    // Seed turn: same shape as the issue panel's "Create PR" seeding, minus
    // the open-a-PR instruction (headless mode never opens one), plus the
    // issue's comments (#150) and its Homeroom-side Discussion thread
    // (#945) so answers to earlier clarifying questions are visible to this
    // run wherever the reporter left them. The thread load never throws —
    // it degrades to the comments-only seed.
    const issueThread = await threadContext.loadIssueThread(pool, session.app_id, issueNumber);
    const seed = buildHeadlessSeed(
      issueNumber, issue, comments, botUsername, issueThread.messages
    );
    if (!resume) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
        [session.id, seed]
      );
    }

    if (registry.resolveBackend(session.agent_backend) === 'codex_openrouter') {
      await setHeadlessStep(pool, session.id, 'cc_running');
      const identity = codingAgentRuntimeIdentity(session, null, config);
      await sendStatus(
        `Auto session: sending issue #${issueNumber} to OpenRouter (${identity.modelLabel})...`,
        identity.metadata,
      );
      const toolResult = await runClaudeCodeTool({
        pool, config, req: fakeReq, res: fakeRes, session, selectedModel,
        userMessage: seed,
        toolPromptArg: seed,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle: null,
        userApiKey: null,
        headless: true,
        directSessionTurn: true,
        beforeTurnCleanup: async ({ isError, commitSha }) => {
          outcome = isError || !commitSha ? 'question' : 'code';
          headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
        },
      });
      outcome = toolResult.isError || !toolResult.commitSha ? 'question' : 'code';
      if (!headlessTurnId) {
        headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
      }
      const directText = toolResult.toolResultText
        || (toolResult.isError
          ? '_The OpenRouter run did not complete successfully. Review the status above._'
          : '_Change committed and pushed. Start a session from this auto session to review it._');
      if (!toolResult.isError && !toolResult.commitSha && directText.trim()) {
        questionTextToPost = directText;
      }
      const messageApplied = await persistHeadlessMayorRow({
        pool,
        sessionId: session.id,
        headlessTurnId,
        text: directText,
        model: identity.model ? `openrouter/${identity.model}` : null,
        usage: null,
        costCents: 0,
        metadata: {
          ...headlessWrapUpMeta(toolResult.isError ? 'failed' : outcome),
          openRouterDirect: true,
        },
      });
      if (messageApplied) send('mayor_reasoning', { text: directText });
      await finalizeReady();
      return;
    }

    await setHeadlessStep(pool, session.id, 'planning');
    // #896: one label either way. This row is copied verbatim into any dev
    // chat cloned from this auto session, where "after a platform restart"
    // is platform plumbing the reader can do nothing with.
    await sendStatus('Auto session: thinking about the issue...');

    const headlessAddendum = buildHeadlessAddendum(issueNumber);
    // #945: no discussionBlock here on purpose. The issue's discussion is
    // already in the SEED (this run's only user message), and a
    // brand-new auto session has no proposal thread of its own yet — so
    // the block would be pure duplication. get_github_issue still returns
    // both surfaces if the Mayor asks for a different issue.
    const mayorPrompt = getMayorSystemPrompt(session.app_name, false, '', !!session.app_self_hosted, null) + headlessAddendum;
    const tools = [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, SUGGEST_ANSWERS_TOOL, LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL, WEB_FETCH_TOOL];

    // --- Phase 1: Mayor turn (same data-tool loop as the chat handler) ---
    // web_fetch is available here too (#30): if the issue links to a web
    // page, the auto-solve run can read it before dispatching.
    let mayor1;
    let mayorConvo = [{ role: 'user', content: seed }];
    let dataIters = 0;
    for (;;) {
      mayor1 = await llm.streamChat({
        messages: mayorConvo,
        systemPrompt: mayorPrompt,
        model: selectedModel,
        tools,
        apiKey: userApiKey,
        telemetryContext: invocationTelemetry(
          pool,
          session,
          dataIters === 0 ? 'headless_decision' : 'mayor_data_iteration',
        ),
      });
      await noteModelFallback(mayor1);

      const dataCalls = mayor1.toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));
      // suggest_answers (#32) is terminal here too — same dangling-
      // tool_use rationale as the interactive loop.
      const hasTerminalTool = mayor1.toolUses.some((t) =>
        t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'
        || t.name === 'suggest_answers');
      if (!dataCalls.length || hasTerminalTool || dataIters >= MAYOR_DATA_TOOLS_MAX_ITERS) break;
      dataIters += 1;

      await debitMayorUsage(mayor1.usage, mayor1.servedModel);
      const dataResults = await Promise.all(
        dataCalls.map((tc) => resolveDataToolResult(tc, repoOwner, repoName, null, { pool, appId: session.app_id }))
      );
      mayorConvo = [
        ...mayorConvo,
        { role: 'assistant', content: mayor1.rawContent },
        {
          role: 'user',
          content: dataCalls.map((tc, i) => ({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: dataResults[i],
          })),
        },
      ];
      if (!await resolveHeadlessPayer('data-tool-continuation')) {
        await sendStatus('Auto session paused before another AI call because no current payer is available.');
        // The just-finished provider call was already persisted/debited as
        // an intermediate turn above. Replace it with a zero-usage terminal
        // response so the ordinary no-dispatch path can close the run
        // without double-counting it or acting on dangling tool calls.
        mayor1 = {
          ...mayor1,
          text: '',
          toolUses: [],
          rawContent: [],
          usage: { input_tokens: 0, output_tokens: 0 },
          stopReason: 'billing_unavailable',
        };
        break;
      }
    }

    // Whole-chain refusal (mirrors the interactive handler): record it,
    // persist an explicit status, and clear the tool calls so the run
    // finalizes on the no-dispatch path instead of acting on the
    // declined model's truncated tool_use blocks.
    if (mayor1.stopReason === 'refusal') {
      const refusalCategory = (mayor1.stopDetails && mayor1.stopDetails.category) || null;
      await modelFallback.record(pool, {
        kind: events.EVENT_TYPES.MODEL_REFUSAL,
        userId: user.id, appId: session.app_id, sessionId: session.id,
        requested: selectedModel, served: mayor1.servedModel || selectedModel,
        category: refusalCategory, source: 'headless',
      });
      await sendStatus(modelFallback.refusalText(selectedModel, refusalCategory), {
        modelRefusal: { requested: selectedModel, category: refusalCategory },
      });
      mayor1.toolUses = [];
    }

    let mayorText1 = stripFakeCompletionMarker(mayor1.text, { sessionId: session.id });
    // Q/A mode (#32): same suggestion handling as the interactive route —
    // persisted on the assistant row so the cloned session a human picks
    // up renders the answer chips. Dropped if a dispatch co-occurred.
    const { suggestions: headlessSuggestions } = resolveSuggestedAnswers(mayor1.toolUses);
    // Silent-turn guard (mirrors the interactive handler): a lone
    // suggest_answers with no text block must still leave the run a
    // visible question — both for the cloned session and for the
    // GitHub-issue comment posted from questionTextToPost below.
    if (!mayorText1.trim() && mayor1.stopReason !== 'refusal') {
      const salvaged = salvageAssistantText(mayorText1, headlessSuggestions, null);
      if (salvaged.trim()) {
        mayorText1 = salvaged;
        log.warn('sessions', 'Headless Mayor reply was tool-only — salvaged suggest content into text', {
          sessionId: session.id,
          stopReason: mayor1.stopReason,
          toolNames: mayor1.toolUses.map((t) => t.name),
        });
      }
    }
    const servedModel1 = mayor1.servedModel || selectedModel;
    const costCents1 = mayor1.usage ? llm.estimateCostCents(mayor1.usage, servedModel1) : 0;
    if (mayorText1.trim()) {
      send('mayor_reasoning', { text: mayorText1 });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
        [session.id, mayorText1, servedModel1, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1,
         JSON.stringify(headlessSuggestions ? { suggestions: headlessSuggestions } : {})]
      );
    }
    await debitMayorUsage(mayor1.usage, mayor1.servedModel);

    const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
    const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');
    const activeToolCall = scoutCall || dispatchCall || null;
    const toolKind = scoutCall ? 'scout' : (dispatchCall ? 'build' : null);

    if (!activeToolCall) {
      // Pure text turn — the Mayor asked a question (or answered directly).
      // That IS the outcome; a human picks it up from a cloned session.
      outcome = 'question';
      if (!mayorText1.trim() && mayor1.stopReason !== 'refusal') {
        // Nothing visible at all (no text, nothing salvageable, no
        // dispatch): persist an explicit note so the cloned session
        // doesn't open onto silence. Refusals already persisted a status.
        await sendStatus('The auto session ended its planning turn without a reply. Re-run "Generate proposal" to retry.', { turnError: true });
        log.warn('sessions', 'Headless Mayor turn produced no visible output — persisted fallback status', {
          sessionId: session.id,
          stopReason: mayor1.stopReason,
          toolNames: mayor1.toolUses.map((t) => t.name),
        });
      }
      if (shouldPostHeadlessQuestionComment({ outcome, dispatchedTool: activeToolCall, mayorText: mayorText1 })) {
        questionTextToPost = mayorText1;
      }
    } else {
      const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
        ? activeToolCall.input.prompt.trim()
        : seed;

      const toolArgs = {
        pool, config, req: fakeReq, res: fakeRes, session, selectedModel,
        userMessage: seed,
        toolPromptArg,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle: null,
        userApiKey,
        beforeTurnCleanup: async ({ isError }) => {
          const checkpointOutcome = isError
            ? 'question'
            : (toolKind === 'scout' ? 'spec' : 'code');
          headlessTurnId = await checkpointHeadlessWrapUp(
            pool, session.id, checkpointOutcome,
          );
        },
      };
      // Checkpoint BEFORE the dispatch: if the platform restarts while
      // the (detached) CC turn runs, resumeHeadlessRuns finds
      // headless_step='cc_running' + active_turn and picks the turn back
      // up from its journal instead of failing the run.
      await setHeadlessStep(pool, session.id, 'cc_running');
      const toolResult = toolKind === 'scout'
        ? await runScoutTool({ ...toolArgs, headless: true })
        : await runClaudeCodeTool({ ...toolArgs, headless: true });

      // The coding phase can consume the last available platform credit.
      // Later Mayor calls are optional presentation work: resolve again and
      // use deterministic wrap-ups if neither platform credit nor BYOK is
      // currently available.
      let postDispatchBillingAvailable = await resolveHeadlessPayer('post-dispatch');

      if (toolResult.isError) {
        outcome = 'question';
      } else {
        outcome = toolKind === 'scout' ? 'spec' : 'code';
      }
      // Checkpoint the outcome with the wrapping transition so a restart
      // during the phase-2 Mayor call can finalize with the right state.
      // (#170: a restart mid-decision-turn deliberately lands here too —
      // the 'wrapping' resume re-issues a tool-less wrap-up and finalizes
      // as 'spec', degrading to "stop for human review". #178: that same
      // degrade covers the questions-after-scout case, except that the
      // resume finalization flips to 'question' when the spec carries a
      // blocking Questions section — without posting a comment, since the
      // decision text died with the old process.)
      if (!headlessTurnId) {
        headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
      }

      // Tool results fed back to the Mayor for phase 2.
      const phase2ToolResults = [];
      for (const tu of mayor1.toolUses) {
        if (tu.id === activeToolCall.id) {
          phase2ToolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolResult.toolResultText,
            ...(toolResult.isError ? { is_error: true } : {}),
          });
        } else if (DATA_TOOL_NAMES.has(tu.name)) {
          phase2ToolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: await resolveDataToolResult(tu, repoOwner, repoName, null, { pool, appId: session.app_id }),
          });
        } else {
          phase2ToolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'Skipped: only one action runs per turn.',
            is_error: true,
          });
        }
      }
      const currentSpec = await loadSessionSpec(pool, session.id);
      const wrapPrompt = getMayorSystemPrompt(session.app_name, false, currentSpec, !!session.app_self_hosted, null) + headlessAddendum;
      const phase2Messages = [
        ...mayorConvo,
        { role: 'assistant', content: mayor1.rawContent },
        { role: 'user', content: phase2ToolResults },
      ];

      if (toolKind === 'scout' && !toolResult.isError) {
        // --- Phase 2 = DECISION turn (#170): the spec is in the system
        // prompt (wrapPrompt embeds currentSpec); the Mayor may dispatch
        // ONE headless build if the spec is straightforward, else reply in
        // plain text (identical to the old behaviour). Only DISPATCH_TOOL
        // is exposed — there is structurally no path to a second scout.
        // #178: a spec that still carries a blocking Questions section
        // after the scout's investigation routes to the reporter instead —
        // the decision text becomes a posted issue comment and the run
        // finalizes as 'question' so Generate proposal can be re-run with answers.
        const specHasQuestions = specHasBlockingQuestions(currentSpec);
        const decisionTurnId = headlessTurnId;
        const decisionFallback = specHasQuestions
          ? '_The spec has open questions. Review them before implementation._'
          : '_Spec drafted. Review it in the spec viewer after starting a session from this auto session._';
        const decisionEffect = await runHeadlessMayorEffect({
          pool,
          sessionId: session.id,
          headlessTurnId: decisionTurnId,
          fallbackText: decisionFallback,
          allowInvoke: postDispatchBillingAvailable,
          invoke: () => llm.streamChat({
            messages: phase2Messages,
            systemPrompt: wrapPrompt + buildHeadlessDecisionAddendum(issueNumber),
            model: selectedModel,
            tools: [DISPATCH_TOOL],
            apiKey: userApiKey,
            telemetryContext: invocationTelemetry(pool, session, 'headless_decision'),
          }),
        });
        const mayor2 = decisionEffect.response;
        if (decisionEffect.disposition === 'executed') await noteModelFallback(mayor2);
        const servedModel2 = mayor2.servedModel || selectedModel;
        const buildCall = mayor2.toolUses.find((t) => t.name === 'dispatch_claude_code');
        const strayCalls = mayor2.toolUses.filter((t) => t.name !== 'dispatch_claude_code');
        const mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
        const costCents2 = mayor2.usage
          ? llm.estimateCostCents(mayor2.usage, servedModel2)
          : 0;

        if (!mayor2.toolUses.length) {
          // Text only. Without open Questions the decision text IS the
          // wrap-up message and outcome stays 'spec'. With a Questions
          // section (#178) the text is the reporter-facing questions:
          // finalize as 'question' (re-run stays unblocked) and post it.
          // Blank text posts nothing — the spec itself carries the
          // questions for the human reviewer.
          if (specHasQuestions) {
            outcome = 'question';
            questionTextToPost = mayorText2.trim();
          }
          const finalText = mayorText2.trim()
            ? mayorText2
            : (specHasQuestions
              ? '_The spec has open questions. Review the Questions section in the spec viewer after starting a session from this auto session._'
              : '_Spec drafted. Review it in the spec viewer after starting a session from this auto session._');
          const messageApplied = await persistHeadlessMayorRow({
            pool,
            sessionId: session.id,
            headlessTurnId: decisionTurnId,
            text: finalText,
            model: servedModel2,
            usage: mayor2.usage,
            costCents: costCents2,
            metadata: headlessWrapUpMeta(outcome),
          });
          if (messageApplied) send('mayor_reasoning', { text: finalText });
          await settleHeadlessMayorUsage({
            pool,
            userId: user.id,
            sessionId: session.id,
            headlessTurnId: decisionTurnId,
            usage: mayor2.usage,
            servedModel: mayor2.servedModel,
            selectedModel,
            userApiKey,
            emit: send,
          });
        } else {
          // The Mayor called a tool — persist its stated rationale first
          // (same text-plus-dispatch pattern phase-1 uses).
          if (mayorText2.trim()) {
            const messageApplied = await persistHeadlessMayorRow({
              pool,
              sessionId: session.id,
              headlessTurnId: decisionTurnId,
              text: mayorText2,
              model: servedModel2,
              usage: mayor2.usage,
              costCents: costCents2,
              metadata: {},
            });
            if (messageApplied) send('mayor_reasoning', { text: mayorText2 });
          }
          await settleHeadlessMayorUsage({
            pool,
            userId: user.id,
            sessionId: session.id,
            headlessTurnId: decisionTurnId,
            usage: mayor2.usage,
            servedModel: mayor2.servedModel,
            selectedModel,
            userApiKey,
            emit: send,
          });

          const decisionToolResults = [];
          if (buildCall && specHasQuestions) {
            // #178 hard rail: the decision addendum forbids dispatching
            // over an open Questions section, but enforcement lives here —
            // the build never runs (no budget check, no dispatch) and the
            // phase-3 wrap-up writes the reporter-facing questions instead.
            outcome = 'question';
            await setHeadlessStep(pool, session.id, 'wrapping', outcome);
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: buildCall.id,
              content: 'Rejected — the spec has an open Questions section; reply with ONLY the numbered questions for the issue reporter instead.',
              is_error: true,
            });
          } else if (buildCall) {
            // Re-resolve the billing path before the second dispatch: the
            // scout already spent real money this run and may have drained
            // the daily allowance. Limit-first (#212): headroom left → the
            // build stays platform-billed; allowance gone + BYOK key on
            // file → the build proceeds on the key (previously it was
            // skipped); allowance gone + no key → skip, as today.
            const buildBilling = await limits.resolveBillingPath(pool, config.dataEncryptionKey, user.id);
            let buildResult;
            if (buildBilling.error) {
              await sendStatus('Spec drafted; implementation skipped, because the daily budget was reached.');
              buildResult = {
                toolResultText: 'Implementation skipped — the daily LLM budget is exhausted. The spec remains the deliverable; a human will review and build it later.',
                isError: true,
              };
            } else {
              // Later phase calls (the build itself, the phase-3 wrap-up
              // and its debits) must bill the re-resolved payer — the
              // turn-start resolution may differ now that the scout spent.
              userApiKey = buildBilling.apiKey;
              await sendStatus('Auto session: spec looks straightforward, so implementing it now...');
              const buildPromptArg = typeof buildCall.input?.prompt === 'string' && buildCall.input.prompt.trim()
                ? buildCall.input.prompt.trim()
                : seed;
              // Same pre-dispatch checkpoint as phase-1: the step machine
              // reuses 'cc_running'; active_turn.mode === 'build'
              // disambiguates scout vs build on resume.
              await setHeadlessStep(pool, session.id, 'cc_running');
              buildResult = await runClaudeCodeTool({
                ...toolArgs,
                userApiKey,
                toolPromptArg: buildPromptArg,
                headless: true,
                beforeTurnCleanup: async ({ isError }) => {
                  const checkpointOutcome = isError ? 'spec' : 'spec_code';
                  headlessTurnId = await checkpointHeadlessWrapUp(
                    pool, session.id, checkpointOutcome,
                  );
                },
              });
            }
            // Build error degrades to 'spec' (NOT 'question' like the
            // phase-1 build path): the spec is the durable artifact and a
            // failed implementation attempt must not mask it.
            outcome = buildResult.isError ? 'spec' : 'spec_code';
            if (headlessTurnId === decisionTurnId) {
              headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
            }
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: buildCall.id,
              content: buildResult.toolResultText,
              ...(buildResult.isError ? { is_error: true } : {}),
            });
          }
          // Any other tool call is rejected without running — the
          // structural enforcement of "max one scout per run".
          for (const tu of strayCalls) {
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'Only dispatch_claude_code is available in the decision turn.',
              is_error: true,
            });
          }

          // --- Phase 3: tool-less wrap-up (mirrors the old phase-2). ---
          if (headlessTurnId === decisionTurnId) {
            headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
          }
          const phase3Fallback = outcome === 'spec_code'
            ? '_Spec drafted and change committed. Start a session from this auto session to review it and propose it to the group._'
            : outcome === 'question'
              ? '_The spec has open questions. Review the Questions section in the spec viewer after starting a session from this auto session._'
              : '_Spec drafted, but the implementation attempt did not complete; review the spec in the spec viewer after starting a session from this auto session._';
          postDispatchBillingAvailable = await resolveHeadlessPayer('phase-3-wrapup');
          const phase3Effect = await runHeadlessMayorEffect({
            pool,
            sessionId: session.id,
            headlessTurnId,
            fallbackText: phase3Fallback,
            allowInvoke: postDispatchBillingAvailable,
            invoke: () => llm.streamChat({
              messages: [
                ...phase2Messages,
                { role: 'assistant', content: mayor2.rawContent || [] },
                { role: 'user', content: decisionToolResults },
              ],
              systemPrompt: wrapPrompt,
              model: selectedModel,
              // #32: on the rejected-build (question) path the wrap-up
              // re-asks the human-only questions — expose suggest_answers so
              // it can attach answer chips, mirroring the phase-1 question
              // turn. Other wrap-up outcomes ignore the tool.
              tools: [SUGGEST_ANSWERS_TOOL],
              apiKey: userApiKey,
              telemetryContext: invocationTelemetry(pool, session, 'headless_wrapup'),
            }),
          });
          const mayor3 = phase3Effect.response;
          if (phase3Effect.disposition === 'executed') await noteModelFallback(mayor3);
          let mayorText3 = stripFakeCompletionMarker(mayor3.text, { sessionId: session.id });
          // #32: persist suggestions only on the question outcome — that's
          // the row a cloned session forwards onto its follow-up to render
          // the answer chips. Non-question wrap-ups carry no metadata.
          const { suggestions: decisionSuggestions } = outcome === 'question'
            ? resolveSuggestedAnswers(mayor3.toolUses)
            : { suggestions: null };
          // #178: on the rejected-build path the wrap-up text IS the
          // reporter-facing questions; blank text posts nothing (the spec
          // carries the questions for the human reviewer).
          if (outcome === 'question') questionTextToPost = mayorText3.trim();
          if (!mayorText3.trim()) {
            mayorText3 = outcome === 'spec_code'
              ? '_Spec drafted and change committed. Start a session from this auto session to review it and propose it to the group._'
              : outcome === 'question'
                ? '_The spec has open questions. Review the Questions section in the spec viewer after starting a session from this auto session._'
                : '_Spec drafted, but the implementation attempt did not complete; review the spec in the spec viewer after starting a session from this auto session._';
          }
          const servedModel3 = mayor3.servedModel || selectedModel;
          const costCents3 = mayor3.usage
            ? llm.estimateCostCents(mayor3.usage, servedModel3)
            : 0;
          const messageApplied = await persistHeadlessMayorRow({
            pool,
            sessionId: session.id,
            headlessTurnId,
            text: mayorText3,
            model: servedModel3,
            usage: mayor3.usage,
            costCents: costCents3,
            metadata: headlessWrapUpMeta(outcome, { suggestions: decisionSuggestions }),
          });
          if (messageApplied) send('mayor_reasoning', { text: mayorText3 });
          await settleHeadlessMayorUsage({
            pool,
            userId: user.id,
            sessionId: session.id,
            headlessTurnId,
            usage: mayor3.usage,
            servedModel: mayor3.servedModel,
            selectedModel,
            userApiKey,
            emit: send,
          });
        }
      } else {
        // --- Phase 2: Mayor wrap-up (mirrors the chat handler) — scout
        // error, direct phase-1 build, or any other dispatch path. ---
        const directFallback = toolResult.isError
          ? "_The auto session's dispatch didn't finish successfully. See the status above._"
          : '_Change committed and pushed. Start a session from this auto session to review it and propose it to the group._';
        const directEffect = await runHeadlessMayorEffect({
          pool,
          sessionId: session.id,
          headlessTurnId,
          fallbackText: directFallback,
          allowInvoke: postDispatchBillingAvailable,
          invoke: () => llm.streamChat({
            messages: phase2Messages,
            systemPrompt: wrapPrompt,
            model: selectedModel,
            tools,
            toolChoice: { type: 'none' },
            apiKey: userApiKey,
            telemetryContext: invocationTelemetry(pool, session, 'headless_wrapup'),
          }),
        });
        const mayor2 = directEffect.response;
        if (directEffect.disposition === 'executed') await noteModelFallback(mayor2);

        let mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
        if (!mayorText2.trim()) {
          mayorText2 = toolResult.isError
            ? "_The auto session's dispatch didn't finish successfully. See the status above._"
            : '_Change committed and pushed. Start a session from this auto session to review it and propose it to the group._';
        }
        const servedModelW = mayor2.servedModel || selectedModel;
        const costCents2 = mayor2.usage
          ? llm.estimateCostCents(mayor2.usage, servedModelW)
          : 0;
        const messageApplied = await persistHeadlessMayorRow({
          pool,
          sessionId: session.id,
          headlessTurnId,
          text: mayorText2,
          model: servedModelW,
          usage: mayor2.usage,
          costCents: costCents2,
          metadata: headlessWrapUpMeta(toolResult.isError ? 'failed' : outcome),
        });
        if (messageApplied) send('mayor_reasoning', { text: mayorText2 });
        await settleHeadlessMayorUsage({
          pool,
          userId: user.id,
          sessionId: session.id,
          headlessTurnId,
          usage: mayor2.usage,
          servedModel: mayor2.servedModel,
          selectedModel,
          userApiKey,
          emit: send,
        });
      }
    }

    await finalizeReady();
  } catch (err) {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    let retainedTurn = null;
    try {
      retainedTurn = await turnLifecycle.loadActiveTurn(pool, session.id);
    } catch (loadErr) {
      // A DB outage cannot prove there is no replay owner. Keep the run in
      // generating and let the retained scheduler re-read it later.
      err.retainActiveTurn = true;
      log.warn('sessions', 'Could not inspect failed headless turn; retaining recovery ownership', {
        sessionId: session.id, err: loadErr.message,
      });
    }
    let recoveryDisposition = null;
    if (retainedTurn) {
      try {
        recoveryDisposition = await recoveryRetry.retainOrQuarantineRecoveryError({
          pool,
          sessionId: session.id,
          activeTurn: retainedTurn,
          error: err,
        });
      } catch (quarantineErr) {
        err = quarantineErr;
      }
    }
    if (recoveryDisposition?.action === 'quarantine') {
      log.error('sessions', 'Headless run has invalid durable state; leaving turn quarantined', {
        sessionId: session.id,
        turnId: turnLifecycle.turnIdentity(retainedTurn),
        err: err.message,
      });
      await failHeadlessRun(
        pool,
        session,
        `Auto session could not be completed: ${String(err.message || err).substring(0, 200)}`,
      );
      return;
    }
    if (retainedTurn || headlessTurnId || err?.retainActiveTurn) {
      err.retainActiveTurn = true;
      log.warn('sessions', 'Headless tail paused with durable state retained', {
        sessionId: session.id,
        turnId: turnLifecycle.turnIdentity(retainedTurn),
        headlessTurnId,
        err: err.message,
      });
      scheduleRetainedHeadlessRecovery({ pool, config, session });
      return;
    }
    log.error('sessions', 'Headless session failed', { sessionId: session.id, err: err.message, stack: err.stack });
    await pool.query(
      `UPDATE chat_sessions
          SET headless_status = 'failed', headless_step = NULL, headless_turn_id = NULL
        WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    await sendStatus(`Auto session failed: ${String(err.message || err).substring(0, 200)}`);
    send('headless_update', { status: 'failed', issueNumber, appSlug: session.app_slug });
    sessionState.touch(session.id);
    // #161: a failed run is still a completion — the user must come back
    // and retry (or read the failure), so notify with detail='failed'.
    await notifyAutoSolveDone(pool, {
      userId: user.id, appId: session.app_id, sessionId: session.id, detail: 'failed',
    });
  } finally {
    // unref: a fire-and-forget cleanup timer must not hold the process
    // open (it also kept the node:test runner alive for the full delay).
    setTimeout(() => sessionBus.clearSession(session.id), 30000).unref();
  }
}

// The Mayor wrap-up for an INTERACTIVE dev-chat turn recovered after a
// platform restart (#896). Called from server.js's resumeDetachedTurnInner.
//
// Why this exists: on a dispatch turn the closing message AND the
// quick-reply pills come only from the phase-2 wrap-up in the chat
// handler above, which needs a live request (req.user, the SSE stream,
// the tool_use → tool_result round-trip). A restart kills all three, so a
// recovered turn used to end on a "Coding turn recovered after a platform
// restart." breadcrumb with no Mayor reply at all — visibly a different,
// half-broken kind of turn. This re-issues the same call off the boot
// path, exactly as resumeOneHeadlessRunInner already does for auto
// sessions: rebuild the transcript from the DB, hand the model the
// dispatch outcome as a synthetic note, persist a normal assistant row.
//
//   outcome          — 'code' | 'spec' | 'push_failed' | 'no_changes',
//                      used only to pick the fallback text.
//   dispatchSummary  — what finalizeRecoveredTurn (or the scout branch)
//                      actually did; the same narrative the live path
//                      feeds back as its tool_result.
//   fallbackPillKind — recovery-pills kind used when the model declines
//                      to call suggest_replies, so the pill bar is never
//                      left empty.
//   turnModel        — active_turn.model, the model the dispatched turn
//                      itself ran under; falls back to the session's most
//                      recent assistant row, then the platform default.
//   emit             — session-event emitter (global WS) so an open tab
//                      paints the bubble and pills without a reload.
//
function snapshotMayorResponse(response) {
  return {
    text: typeof response?.text === 'string' ? response.text : '',
    usage: response?.usage || null,
    toolUses: Array.isArray(response?.toolUses) ? response.toolUses : [],
    rawContent: Array.isArray(response?.rawContent) ? response.rawContent : [],
    servedModel: response?.servedModel || null,
    fallbackServed: response?.fallbackServed === true,
    stopReason: response?.stopReason || null,
    stopDetails: response?.stopDetails || null,
  };
}

// #1378: the "…and here is what it had already committed" clause of a stop.
//
// Stopping a turn discards work in progress, but not necessarily ALL of it:
// the agent may have committed and pushed before the stop landed. Saying
// only "Stopped." there is actively misleading, because the user's branch
// has moved and re-sending the same request buys them a duplicate run.
//
// Extracted so the RECOVERED path can say the same thing as the live one.
// A recovered turn reaches this from the durable tail milestones
// (active_turn.tail.sha / .pushOk, written by markTurnTail) rather than
// from an in-memory exec result, and those carry no commit COUNT — hence
// `ahead: null` meaning "a commit landed, quantity unknown". A NUMERIC
// ahead is authoritative and 0 means nothing landed, which preserves the
// live path's behaviour exactly (an absent `ahead` there has always read
// as "nothing landed", so that caller passes `?? 0`, not null).
function describeStoppedLanding({ sha = null, ahead = null, pushOk = false } = {}) {
  if (!sha) return '';
  if (ahead != null && !(ahead > 0)) return '';
  const what = ahead != null
    ? `${ahead} change${ahead === 1 ? '' : 's'}`
    : 'changes';
  return `, but it had already committed ${what} to the branch`
    + ` (${String(sha).slice(0, 8)}${pushOk ? ', pushed' : ', not pushed'});`
    + ' no pull request was opened';
}

// The SAME facts describeStoppedLanding renders as a clause, kept as data.
// The sentence stays the record — a notification, a plain-text export and a
// shared transcript all show prose — but the dev chat should not have to
// parse its own prose back out to draw a commit count, and a stop that
// landed commits is the one turn outcome the transcript most needs to state
// precisely. `ahead: null` means "a commit landed, quantity unknown" here
// exactly as it does above; it surfaces as a countless chip rather than as
// a wrong number. `headline` is the sentence WITHOUT the landed clause, so
// the row can put the facts in chips beside it instead of saying them twice.
function stopLandingMeta({ headline, sha = null, ahead = null, pushOk = false } = {}) {
  const landed = !!sha && (ahead == null || ahead > 0);
  return {
    headline,
    commits: landed ? (ahead == null ? null : ahead) : 0,
    sha: landed ? String(sha).slice(0, 8) : null,
    pushOk: landed ? pushOk === true : false,
  };
}

function staticWrapUpText(outcome, { toolKind = null } = {}) {
  if (outcome === 'push_failed' || outcome === 'failed') {
    return toolKind === 'scout'
      ? "_The scout didn't finish successfully. See the status above._"
      : "_The coding agent didn't complete successfully. See the status messages above._";
  }
  if (outcome === 'spec' || outcome === 'spec_done') {
    return "_Spec updated: it's in the spec viewer. Tell me to build it whenever you're ready and I'll dispatch the coding agent._";
  }
  if (outcome === 'no_changes') {
    return '_The coding agent finished without changing anything. See the status messages above._';
  }
  return '_Done._';
}

// Durable recovery propagates receipt/message/spend failures so the retained
// turn can retry its tail. Provider ambiguity itself never throws: it is
// reconciled with a deterministic closing line and, crucially, is never
// re-issued. Legacy rows without a turnId retain the old best-effort behavior.
async function runRecoveredWrapUp({
  pool, config, session, sessionId, outcome, dispatchSummary,
  fallbackPillKind, turnModel, turnId = null, emit = () => {}, signal = null,
}) {
  const recoveryPills = require('../services/recovery-pills');
  const fallbackPills = recoveryPills.buildRecoveryQuickReplies(fallbackPillKind);

  // The static closing line used when the model call can't be made or
  // fails — mirrors the live wrap-up's empty-text guards, so a degraded
  // recovery still ends on a normal-looking assistant bubble.
  const isOpenRouterSession = registry.resolveBackend(session?.agent_backend) === 'codex_openrouter';
  const fallbackText = isOpenRouterSession
    ? (outcome === 'failed' || outcome === 'push_failed'
      ? '_The OpenRouter turn did not complete successfully._'
      : '_OpenRouter finished the turn without a response._')
    : staticWrapUpText(outcome);

  // Persist the wrap-up as an ordinary assistant row: same columns the
  // live phase-2 writes, plus metadata.recovered for the audit trail.
  //
  // #1001: `source` rides along so a recovered row is distinguishable in the
  // pill-source telemetry like any live one. Defaults to 'static' because
  // every non-model call site here passes the deterministic fallbackPills.
  const persistWrapUp = async (text, quickReplies, { model, usage, costCents, source = 'static', kind } = {}) => {
    const params = [
      sessionId, text, model || null,
      usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : null,
      costCents || null,
      JSON.stringify({
        ...(quickReplies ? { quickReplies, quickRepliesSource: source } : {}),
        ...(quickReplies && source === 'static' && (kind || fallbackPillKind)
          ? { quickRepliesKind: kind || fallbackPillKind } : {}),
        recovered: true,
      }),
    ];
    const insert = (client) => client.query(
      `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
      params,
    );
    let shouldEmit = true;
    if (turnId) {
      const receipt = await turnEffects.runDbEffect({
        pool,
        turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.message,
        sessionId,
        run: async (client) => {
          await insert(client);
          return { persisted: true };
        },
      });
      shouldEmit = receipt.applied;
    } else {
      await insert(pool);
    }
    // mayor_reasoning opens/reconciles the assistant bubble; quick_replies
    // then attaches to it (same emit order as the live phase-2). No 'done'
    // — a concurrent user turn could be streaming, and 'done' would tear
    // its client-side streaming state down.
    if (shouldEmit) {
      emit('mayor_reasoning', { text });
      if (quickReplies) emit('quick_replies', { replies: quickReplies });
    }
  };

  // A recovered OpenRouter turn keeps the same single-provider contract as
  // a live one. Its coding-agent summary is already durable, so close the
  // turn from that result without resolving Anthropic billing or calling a
  // second model behind the user's back.
  if (isOpenRouterSession) {
    const text = String(dispatchSummary || '').trim() || fallbackText;
    await persistWrapUp(text, fallbackPills, {
      model: session?.agent_model ? `openrouter/${session.agent_model}` : null,
      kind: fallbackPillKind,
    });
    return { ok: true, text, quickReplies: fallbackPills, provider: 'openrouter' };
  }

  if (!llm.isEnabled()) {
    log.warn('sessions', 'Recovered wrap-up skipped: LLM not configured', { sessionId });
    await persistWrapUp(fallbackText, fallbackPills);
    return { ok: false, reason: 'llm_disabled' };
  }

  try {
    // Limit-first billing, same posture as a live wrap-up: spend the daily
    // allowance while it lasts, then the owner's own key. Recovery already
    // has the coding result, so a missing payer degrades to deterministic
    // text instead of issuing a new platform-funded call.
    let userApiKey = null;
    let wrapUpBillingAvailable = false;
    try {
      const billing = await limits.resolveBillingPath(pool, config.dataEncryptionKey, session.user_id);
      if (!billing.error) {
        userApiKey = billing.apiKey;
        wrapUpBillingAvailable = true;
      } else {
        log.info('sessions', 'Recovered wrap-up using deterministic fallback: no payer available', {
          sessionId, reason: billing.reason || null,
        });
      }
    } catch (err) {
      log.warn('sessions', 'Recovered wrap-up billing resolve failed; using deterministic fallback', {
        sessionId, err: err.message,
      });
    }

    let selectedModel = models.resolve(turnModel);
    if (!turnModel) {
      const { rows: modelRows } = await pool.query(
        `SELECT model FROM chat_session_messages
         WHERE session_id = $1 AND role = 'assistant' AND model IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );
      selectedModel = models.resolve(modelRows[0]?.model);
    }

    // Same history shape the live turn builds its context from: user +
    // assistant rows plus the coding agent's own summaries (ccOutput
    // system rows). finalizeRecoveredTurn now persists that completion
    // row before calling us, so the agent's description of the change is
    // already folded in under the [CODING AGENT COMPLETED] marker.
    const { rows: history } = await pool.query(
      `SELECT id, role, content, metadata FROM chat_session_messages
       WHERE session_id = $1
         AND (role IN ('user', 'assistant')
              OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL))
       ORDER BY id ASC`,
      [sessionId]
    );
    const messages = buildMayorMessages(history);

    // The original tool_use blocks died with the pre-restart process, so
    // the dispatch outcome arrives as a plain user note instead (the API
    // accepts consecutive same-role messages). The instruction to not
    // mention the restart is the whole point of #896: the user asked why
    // it can't "just work exactly like normal".
    messages.push({
      role: 'user',
      content: `[SYSTEM NOTE — not the human] The coding agent you dispatched has finished. `
        + `Result:\n\n${dispatchSummary || '(no details available)'}\n\n`
        + 'Write your wrap-up reply to the user now: say what changed and what they can do '
        + 'next. Write it exactly as '
        + 'you would for any other finished build — do NOT mention platform restarts, recovery, '
        + 'interruptions, delays, or this note itself. Call suggest_replies with 2-3 next steps '
        + 'that NAME what changed here, not generic platform actions — with the one exception in '
        + 'POST-SPEC BUILD PILL: if this turn left a spec and nothing built, the first pill still '
        + 'says "Build the spec" rather than naming one component of it.',
    });

    const currentSpec = await loadSessionSpec(pool, sessionId);
    const prContext = session.pr_number
      ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
      : null;
    // #945: the same discussion context a live phase-2 wrap-up gets — a
    // recovered turn should read like any other finished build, and the
    // thread may well have moved while the platform was down.
    const discussionBlock = await buildSessionDiscussionBlock(pool, session);
    const systemPrompt = getMayorSystemPrompt(
      session.app_name, false, currentSpec, !!session.app_self_hosted, prContext,
      '', '', false, discussionBlock
    );

    const fallbackMayor = {
      ...snapshotMayorResponse({ text: fallbackText }),
      recoveryFallback: true,
    };
    const invokeMayor = async () => wrapUpBillingAvailable
      ? snapshotMayorResponse(await llm.streamChat({
      messages,
      systemPrompt,
      model: selectedModel,
      // Only the pills tool, exactly like phase-2: the wrap-up may suggest
      // next steps but must not be able to dispatch again.
      tools: [SUGGEST_REPLIES_TOOL],
      toolChoice: { type: 'auto' },
      apiKey: userApiKey,
      // #1378: the recovered wrap-up runs under the adopted turn's stop
      // handle like any other phase-2, so a stop that lands while it is
      // streaming aborts the provider call instead of being ignored. The
      // handle's phase is 'mayor2' by the time we get here, so POST /stop
      // answers 'wrap_up_not_stoppable' and this only ever fires for a
      // stop that landed EARLIER and is still unwinding.
      signal: signal || undefined,
      telemetryContext: invocationTelemetry(pool, session, 'mayor_phase_2'),
    }))
      : fallbackMayor;

    let mayor;
    if (turnId) {
      const effect = await turnEffects.runExternalEffectFailClosed({
        pool,
        turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.llm,
        sessionId,
        run: invokeMayor,
        fallback: fallbackMayor,
      });
      mayor = effect.value || fallbackMayor;
      if (effect.disposition === 'fallback') {
        log.warn('sessions', 'Recovered wrap-up provider call failed closed', {
          sessionId, err: effect.error?.message || 'ambiguous pending provider call',
        });
      }
    } else {
      mayor = await invokeMayor();
    }

    const text = stripFakeCompletionMarker((mayor.text || '').trim(), { sessionId })
      || fallbackText;
    const servedModel = mayor.servedModel || selectedModel;
    const costCents = mayor.usage ? llm.estimateCostCents(mayor.usage, servedModel) : 0;

    // Settle the recovered wrap-up before any separate pill-generation
    // request so that request's fresh billing check includes this spend.
    if (costCents) {
      if (turnId) {
        await limits.settleTurnSpend(pool, session.user_id, costCents, {
          turnByok: !!userApiKey,
          turnId,
          sessionId,
          effectKey: TURN_WRAPUP_EFFECT_KEYS.spend,
        });
      } else {
        await limits.recordSpend(pool, session.user_id, costCents, { byok: !!userApiKey });
      }
    }

    // #1001: a recovered wrap-up gets the same ladder as a live one. It
    // qualifies for the forced continuation because it has already resolved
    // a user id and an API key here — the constraint that keeps the BOOT
    // BACKFILL sweep on the static set doesn't apply to this path.
    const staticResolved = {
      replies: fallbackPills,
      source: 'static',
      kind: fallbackPillKind,
    };
    const resolveRecoveredPills = () => resolveTurnPills({
        pool,
        dataKey: config.dataEncryptionKey,
        session,
        userId: session.user_id,
        apiKey: userApiKey,
        model: servedModel,
        modelPills: resolveQuickReplies(mayor.toolUses),
        outcome: outcome === 'spec' ? 'spec_done' : (outcome === 'code' ? 'build_done' : 'failed'),
        hasPr: session.pr_number != null,
        hasSpec: !!(currentSpec || '').trim(),
        replyText: text,
        transcriptTail: history,
        state: `recovered ${outcome} turn; ${session.pr_number != null ? `PR #${session.pr_number} is open` : 'no PR yet'}`,
      });
    let resolved;
    if (mayor.recoveryFallback) {
      resolved = staticResolved;
    } else if (turnId) {
      const pillEffect = await turnEffects.runExternalEffectFailClosed({
        pool,
        turnId,
        effectKey: TURN_WRAPUP_EFFECT_KEYS.pills,
        sessionId,
        run: resolveRecoveredPills,
        fallback: staticResolved,
      });
      resolved = pillEffect.value || staticResolved;
    } else {
      resolved = await resolveRecoveredPills();
    }
    const quickReplies = resolved.replies || fallbackPills;
    log.info('sessions', 'quick replies resolved', {
      sessionId, phase: 'recovered-wrapup',
      source: resolved.source, kind: resolved.kind || null,
    });

    await persistWrapUp(text, quickReplies, {
      model: servedModel, usage: mayor.usage, costCents,
      source: resolved.replies ? resolved.source : 'static',
      kind: resolved.kind,
    });
    log.info('sessions', 'Recovered turn wrap-up posted', {
      sessionId, outcome, model: servedModel, textLen: text.length,
    });
    return {
      ok: !mayor.recoveryFallback,
      ...(mayor.recoveryFallback
        ? { reason: wrapUpBillingAvailable ? 'llm_failed' : 'billing_unavailable' }
        : {}),
      text,
      quickReplies,
    };
  } catch (err) {
    // Receipt/message/spend failures on a durable turn are recovery work, not
    // a reason to declare the tail complete. Propagate them so the scheduler
    // retains ownership and retries from the same effect receipts.
    if (turnId) {
      log.warn('sessions', 'Durable recovered wrap-up tail incomplete', {
        sessionId, outcome, err: err.message,
      });
      throw err;
    }

    // Legacy rows have no stable identity/receipts. Preserve their historical
    // best-effort behavior: a failed model call still posts a static close.
    log.warn('sessions', 'Recovered wrap-up failed — falling back to static close', {
      sessionId, outcome, err: err.message,
    });
    await persistWrapUp(fallbackText, fallbackPills);
    return { ok: false, reason: 'llm_failed' };
  }
}

// Boot hook: resume headless auto sessions that were 'generating' when
// the platform went down, instead of blanket-failing them (the old
// failOrphanedHeadlessRuns behavior — now narrowed in migrate.js to
// only rows that predate the step machine). Driven by the persisted
// headless_step checkpoint:
//   planning   → re-issue the whole Mayor turn from the persisted seed
//                message (cheap, retry-safe — nothing was dispatched yet).
//   cc_running → pick the detached CC turn back up from its journal
//                (chat_sessions.active_turn), run headless post-
//                processing, then continue with the wrap-up.
//   wrapping   → the dispatch finished and its outcome was checkpointed;
//                re-issue just the phase-2 Mayor call from the persisted
//                transcript.
// Anything that can't be carried forward is marked 'failed' — same
// terminal state as before, just no longer the only possibility.
async function resumeHeadlessRuns(config) {
  const pool = getPool(config);
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.self_hosted AS app_self_hosted, u.username
       FROM chat_sessions cs
       JOIN apps a ON cs.app_id = a.id
       JOIN users u ON cs.user_id = u.id
       WHERE cs.is_headless = TRUE
         AND (cs.headless_status = 'generating'
              OR cs.active_turn->>'phase' = 'cleanup_pending')`
    ));
  } catch (err) {
    log.error('sessions', 'resumeHeadlessRuns query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;
  log.info('sessions', 'Resuming headless runs after restart', {
    count: rows.length, sessionIds: rows.map((r) => r.id),
  });
  for (const session of rows) {
    resumeOneHeadlessRun({ pool, config, session }).catch(async (err) => {
      if (err?.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) {
        log.warn('sessions', 'Headless resume paused with durable turn state retained', {
          sessionId: session.id, err: err.message,
        });
        scheduleRetainedHeadlessRecovery({ pool, config, session });
        return;
      }
      log.error('sessions', 'Headless resume failed — marking run failed', {
        sessionId: session.id, err: err.message, stack: err.stack,
      });
      await failHeadlessRun(pool, session, `Auto session could not be completed: ${String(err.message || err).substring(0, 200)}`);
    });
  }
}

async function reloadRecoverableHeadlessSession(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.self_hosted AS app_self_hosted, u.username
       FROM chat_sessions cs
       JOIN apps a ON cs.app_id = a.id
       JOIN users u ON cs.user_id = u.id
       WHERE cs.id = $1
         AND cs.is_headless = TRUE
         AND (cs.headless_status = 'generating'
              OR cs.active_turn->>'phase' = 'cleanup_pending')`,
      [sessionId]
    );
    return rows[0] || null;
  } catch (err) {
    // This query is part of an already-retained recovery. A transient DB
    // outage must not demote it to the ordinary "mark failed" path.
    err.retainActiveTurn = true;
    throw err;
  }
}

function scheduleRetainedHeadlessRecovery({
  pool,
  config,
  session,
}) {
  const sessionId = Number(session.id);
  let releaseReservation = null;
  let latestSession = session;
  return recoveryRetry.scheduleRetainedRecovery({
    key: `headless:${sessionId}`,
    hold: () => {
      if (!releaseReservation) releaseReservation = beginSessionOperation(sessionId);
    },
    release: () => {
      releaseReservation?.();
      releaseReservation = null;
    },
    run: async () => {
      const fresh = await reloadRecoverableHeadlessSession(pool, sessionId);
      if (!fresh) return;
      latestSession = fresh;
      const action = turnLifecycle.recoveryAction(fresh.active_turn);
      if (action === 'cleanup') {
        const cleanupArgs = turnLifecycle.cleanupArgs(fresh.active_turn);
        recoveryRetry.requireDurableTurnCleanup(
          await worker.finishTurn(sessionId, cleanupArgs),
          cleanupArgs,
        );
        // cleanup_pending can be the last coding-turn state while the
        // independently identified headless Mayor wrap-up is still pending.
        // Clearing that obsolete coding owner must hand back to wrapping,
        // not strand a generating row forever.
        fresh.active_turn = null;
        if (fresh.headless_status !== 'generating') return;
      }
      if (action === 'quarantine') {
        await failHeadlessRun(
          pool,
          fresh,
          'Auto session could not be completed because its durable coding-turn state is inconsistent.',
        );
        return;
      }
      if (fresh.headless_status !== 'generating') return;
      await resumeOneHeadlessRun({ pool, config, session: fresh });
    },
    onError: async (err, { failures }) => {
      if (err?.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) {
        log.warn('sessions', 'Retrying retained headless recovery', {
          sessionId, failures, err: err.message,
        });
        return true;
      }
      log.error('sessions', 'Retried headless resume failed — marking run failed', {
        sessionId, err: err.message, stack: err.stack,
      });
      await failHeadlessRun(
        pool,
        latestSession,
        `Auto session could not be completed: ${String(err.message || err).substring(0, 200)}`
      );
      return false;
    },
    onComplete: () => log.info('sessions', 'Retained headless recovery completed', { sessionId }),
    onHookError: (err) => log.warn('sessions', 'Headless recovery retry hook failed', {
      sessionId, err: err.message,
    }),
  });
}

// A missing Codex provider thread can be retried once while the original
// process is still alive: its stop state, prompt hand-off and exact dispatch
// boundary are all observable there. After a platform restart that boundary
// is ambiguous. Recovery therefore never creates or re-dispatches a paid
// attempt. It converts the durable record into a terminal tail and asks the
// user to retry explicitly; the ordinary shared settlement below then closes
// the existing ledger attempt exactly once.
async function resumeRecoveredCodexFreshRetry({ pool, session, activeTurn, result }) {
  if (activeTurn?.backend !== 'codex_openrouter') return null;
  const legacyRetryPhase = activeTurn.phase === 'retry_pending'
    || activeTurn.phase === 'retry_dispatch_pending';
  if (result?.agentRetryFresh !== true && !legacyRetryPhase) return null;

  const message = 'The saved OpenRouter model context became unavailable during a platform restart. '
    + 'For safety, no automatic retry was dispatched; retry this turn to start fresh.';
  const patch = {
    retryFresh: false,
    recoveryFailure: 'restart_retry_requires_user',
    tail: {
      ...((activeTurn.tail && typeof activeTurn.tail === 'object') ? activeTurn.tail : {}),
      sha: activeTurn.tail?.sha || result?.sha || null,
      pushOk: activeTurn.tail?.pushOk === true || result?.pushOk === true,
    },
  };

  const transition = await turnLifecycle.markTailPending(pool, {
    sessionId: session.id,
    turnId: activeTurn.turnId || null,
    journal: activeTurn.turnId ? null : activeTurn.journal,
    turnUuid: activeTurn.turnUuid || null,
    patch,
  });
  const recoveredTurn = transition.activeTurn || {
    ...activeTurn,
    phase: turnLifecycle.PHASE_TAIL_PENDING,
    ...patch,
  };
  return {
    result: {
      ...result,
      resultSeen: true,
      execExitSeen: true,
      exitCode: result?.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
      agentExit: result?.agentExit && result.agentExit !== 0 ? result.agentExit : 1,
      agentRetryFresh: false,
      ccIsError: true,
      fatalError: message,
    },
    activeTurn: recoveredTurn,
  };
}

// Terminal failure for a resumed headless run: same row updates + WS
// broadcast the live runner's catch block performs.
async function failHeadlessRun(pool, session, message, { activeTurn = null } = {}) {
  const { broadcastGlobal } = require('../services/ws');
  if (activeTurn) {
    const identity = turnLifecycle.cleanupArgs(activeTurn);
    await turnLifecycle.markHeadlessTerminal(pool, {
      sessionId: session.id,
      ...identity,
      status: 'failed',
    });
  } else {
    await pool.query(
      `UPDATE chat_sessions
          SET headless_status = 'failed', headless_step = NULL, headless_turn_id = NULL
        WHERE id = $1`,
      [session.id]
    ).catch(() => {});
  }
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [session.id, message, JSON.stringify({})]
  ).catch(() => {});
  broadcastGlobal({
    type: 'session_event', sessionId: session.id, event: 'headless_update',
    status: 'failed', issueNumber: session.headless_issue_number, appSlug: session.app_slug,
  });
  sessionState.touch(session.id);
  // #161: terminal state — same completion notification the live
  // runner's catch block fires.
  await notifyAutoSolveDone(pool, {
    userId: session.user_id, appId: session.app_id, sessionId: session.id, detail: 'failed',
  });
}

async function resumeOneHeadlessRun(args) {
  // Register the whole resumed run in the shared activeWorkers set so
  // the auto-pause / staging-GC sweepers see the session as busy for the
  // full recovery (journal tail + staging + wrap-up) — mirrors
  // resumeDetachedTurn in server.js (pause-proof finalization).
  activeWorkers.add(args.session.id);
  try {
    return await resumeOneHeadlessRunInner(args);
  } catch (err) {
    let retainedTurn;
    try {
      retainedTurn = await turnLifecycle.loadActiveTurn(args.pool, args.session.id);
    } catch (loadErr) {
      loadErr.retainActiveTurn = true;
      throw loadErr;
    }
    if (retainedTurn) {
      await recoveryRetry.retainOrQuarantineRecoveryError({
        pool: args.pool,
        sessionId: args.session.id,
        activeTurn: retainedTurn,
        error: err,
      });
    }
    throw err;
  } finally {
    activeWorkers.delete(args.session.id);
  }
}

async function resumeOneHeadlessRunInner({ pool, config, session }) {
  const { broadcastGlobal } = require('../services/ws');
  const initialRecoveryAction = turnLifecycle.recoveryAction(session.active_turn);
  if (initialRecoveryAction === 'quarantine') {
    return failHeadlessRun(
      pool,
      session,
      'Auto session could not be completed because its durable coding-turn state is inconsistent.',
    );
  }
  if (initialRecoveryAction === 'cleanup') {
    const cleanupArgs = turnLifecycle.cleanupArgs(session.active_turn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(session.id, cleanupArgs),
      cleanupArgs,
    );
    session.active_turn = null;
    if (session.headless_status !== 'generating') return;
  }
  const issueNumber = session.headless_issue_number;
  const user = { id: session.user_id, username: session.username };
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!repoOwner || !repoName) {
    return failHeadlessRun(pool, session, 'Auto session failed: no GitHub repo configured.');
  }

  // Limit-first (#212): every newly issued recovery call must have a
  // current payer. Durable coding output can still be finalized without
  // one, but a planning step has no completed work to recover and must be
  // retried after credits or BYOK become available.
  const isOpenRouterSession = registry.resolveBackend(session.agent_backend) === 'codex_openrouter';
  const resumeBilling = isOpenRouterSession
    ? { apiKey: null }
    : await limits.resolveBillingPath(pool, config.dataEncryptionKey, session.user_id);
  let userApiKey = resumeBilling.error ? null : resumeBilling.apiKey;
  // The model picked at start isn't a session column, but every persisted
  // assistant turn carries it — reuse the latest, else the default.
  const { rows: modelRows } = await pool.query(
    `SELECT model FROM chat_session_messages
     WHERE session_id = $1 AND role = 'assistant' AND model IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [session.id]
  );
  const selectedModel = models.resolve(modelRows[0]?.model);

  const step = session.headless_step || 'planning';
  log.info('sessions', 'Resuming headless run', { sessionId: session.id, issueNumber, step });

  if (step === 'planning') {
    if (!isOpenRouterSession && resumeBilling.error) {
      return failHeadlessRun(
        pool,
        session,
        `Auto session could not resume its planning call: ${resumeBilling.error}`,
      );
    }
    // Nothing was dispatched yet — re-issue the whole Mayor turn. The
    // seed user message already exists (resume: true skips re-inserting);
    // re-fetch the issue (+ its comments, #150) for the in-memory seed
    // string the dispatch helpers receive.
    const { issue } = await github.fetchPublicIssue(repoOwner, repoName, issueNumber);
    const { comments } = await github.fetchIssueComments(repoOwner, repoName, issueNumber);
    let botUsername = null;
    try { botUsername = await github.getBotUsername(); } catch {}
    return runHeadlessSession({
      pool, config, session, user, selectedModel,
      repoOwner, repoName, userApiKey, issueNumber, issue,
      comments, botUsername,
      resume: true,
    });
  }

  let outcome = session.headless_outcome || 'question';
  let dispatchSummary = null;
  let recoveredJournal = null;
  let recoveredTurnForCleanup = null;
  let headlessTurnId = session.headless_turn_id || null;

  // New live runners checkpoint wrapping before releasing their coding
  // owner. If the process died in that narrow hand-off, the exec/tail is
  // already complete and this record now exists solely to make cleanup CAS
  // safe after the receipt-backed wrap-up below.
  if (step === 'wrapping' && session.active_turn) {
    recoveredTurnForCleanup = session.active_turn;
    recoveredJournal = session.active_turn.journal || null;
  }

  if (step === 'cc_running') {
    const activeTurn = session.active_turn || null;
    if (!activeTurn || !activeTurn.journal) {
      return failHeadlessRun(pool, session, 'Auto session failed: its coding turn left no resumable record.');
    }
    recoveredJournal = activeTurn.journal;
    // Replay/follow the detached turn's journal. Progress lines are
    // rebuilt WHOLESALE onto the latest progress row (replay re-feeds
    // every line from the start of the turn).
    const progressLines = [];
    let flushQueued = false;
    const flushProgress = () => {
      flushQueued = false;
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify(progressLines), session.id]
      ).catch(() => {});
    };
    const onRecoveredProgress = (text) => {
      broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'cc_progress', text });
      progressLines.push(text);
      if (!flushQueued) {
        flushQueued = true;
        setTimeout(flushProgress, 1000);
      }
    };
    let result = await worker.resumeTurnFromJournal(session.id, {
      journal: activeTurn.journal,
      turnId: activeTurn.turnId || null,
      agentBackend: activeTurn.backend || 'claude_code',
      agentHarness: activeTurn.harness || null,
      telemetryComponent: activeTurn.telemetryComponent
        || (activeTurn.mode === 'scout' ? 'coding_agent_scout'
          : activeTurn.mode === 'build' ? 'coding_agent_build' : null),
      telemetryCorrelationId: activeTurn.telemetryCorrelationId || activeTurn.turnId || null,
      telemetryAttemptNumber: activeTurn.telemetryAttemptNumber || activeTurn.attemptNumber || 1,
      telemetryRequestMode: activeTurn.telemetryRequestMode || null,
      telemetryRequestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
      telemetryRequestSystemCharacters: activeTurn.telemetryRequestSystemCharacters ?? null,
      telemetryRequestPayloadCharacters: activeTurn.telemetryRequestPayloadCharacters ?? null,
      telemetryModelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
      telemetryModelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
      requestedModel: activeTurn.model || null,
      startedAt: activeTurn.startedAt || null,
      attemptNumber: activeTurn.attemptNumber || 1,
      billingByok: activeTurn.byok === true,
      providerWasDispatched: turnLifecycle.phaseOf(activeTurn) !== turnLifecycle.PHASE_DISPATCH_PENDING,
      // #664: seed the per-turn BYOK tally from the persisted record so
      // post-restart switched calls accumulate on top of pre-restart ones.
      byokCentsSoFar: Number(activeTurn.byokCents || 0),
      onProgress: onRecoveredProgress,
    });
    let recoveryActiveTurn = activeTurn;
    try {
      const retried = await resumeRecoveredCodexFreshRetry({
        pool, config, session, activeTurn, result,
        onProgress: onRecoveredProgress,
      });
      if (retried) {
        result = retried.result;
        recoveryActiveTurn = retried.activeTurn;
      }

      // These writes are part of consuming the journal, not optional tail
      // decoration. If either fails, leave active_turn and every journal in
      // place so the next recovery can replay idempotently.
      await agentTurn.persistRecoveredAgentThread({ pool, session, result });
      await agentTurn.settleRecoveredAgentAttempt({
        pool,
        activeTurn: recoveryActiveTurn,
        result,
        settleClaude: async () => {
          // Guard (plan 7.6): recovered Codex spend never reaches Anthropic
          // `limits` — only the Claude branch settles through it here.
          if (!result.costUsd) return null;
          const byok = recoveryActiveTurn.byok ?? !!userApiKey;
          return limits.settleTurnSpend(pool, user.id, Math.round(result.costUsd * 100), {
            turnByok: byok,
            byokObservedCents: worker.getTurnByokCents(session.id),
            turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
            sessionId: session.id,
          });
        },
      });
    } catch (err) {
      const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
        pool,
        sessionId: session.id,
        activeTurn: recoveryActiveTurn,
        error: err,
      });
      log.error('sessions', disposition.action === 'retry'
        ? 'Required recovered-turn persistence failed; retaining durable state'
        : 'Recovered turn has invalid durable state; leaving it quarantined without retry', {
        sessionId: session.id, err: err.message,
      });
      throw err;
    }
    recoveredTurnForCleanup = recoveryActiveTurn;
    // Terminal marker for the recovered turn's progress card (dedup:
    // journals from new worker images already end with their own
    // [done]/[push_failed] marker). Decided before flushing so the
    // wholesale progressLog rewrite carries it.
    const producedAnythingEarly = result.execExitSeen || result.resultSeen
      || !!(result.lastResultText || '').trim();
    const headlessTerminal = !producedAnythingEarly
      ? '[interrupted]'
      : (recoveryActiveTurn.mode !== 'scout' && result.pushOk === false && result.ahead > 0)
        ? '[push_failed]'
        : '[done]';
    if (turnWatchdog.appendTerminalLine(progressLines, headlessTerminal)) {
      broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'cc_progress', text: headlessTerminal });
    }
    flushProgress();
    const producedAnything = result.execExitSeen || result.resultSeen
      || !!(result.lastResultText || '').trim();
    if (!producedAnything) {
      await failHeadlessRun(
        pool,
        session,
        "Auto session failed: its coding turn didn't finish.",
        { activeTurn: recoveryActiveTurn },
      );
      recoveryRetry.requireDurableTurnCleanup(
        await worker.finishTurn(session.id, turnLifecycle.cleanupArgs(recoveryActiveTurn)),
        turnLifecycle.cleanupArgs(recoveryActiveTurn),
      );
      return;
    }

    // Persist the CC session id for later cloned sessions' --resume.
    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
        [newCcId, session.id]
      ).catch(() => {});
    }

    // Headless post-processing — mirrors runScoutTool / runClaudeCodeTool's
    // headless success paths (spec persist / testing notes), never PR or
    // staging (the headless contract).
    if (recoveryActiveTurn.mode === 'scout') {
      const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());
      // #1204: the replayed journal can end on a transport-failure notice
      // just like a live turn does. There is no re-dispatch on this path
      // (the run is being finalized after a platform restart, not driven),
      // so the only correct move is to refuse the "spec" and finalize as a
      // question for a human to pick up.
      const apiFailure = agentApiFailure(ccText);
      if (ccText && !result.fatalError && !apiFailure) {
        const publication = await persistScoutPublication({
          pool,
          sessionId: session.id,
          turnId: recoveryActiveTurn.turnId || null,
          content: ccText,
          conversationContent: result.lastResultText || '',
          hadSpec: !!(session.spec_md || '').trim(),
          agentBackend: recoveryActiveTurn.backend || session.agent_backend || 'claude_code',
          agentModel: recoveryActiveTurn.model || session.agent_model || null,
        });
        session.spec_md = ccText;
        // #178: blocking Questions in the recovered spec finalize as
        // 'question' so the answer-and-re-run loop survives the restart
        // (no comment is posted — there is no decision turn on resume).
        outcome = specHasBlockingQuestions(ccText) ? 'question' : 'spec';
        dispatchSummary = publication.hadSpec
          ? `The scout revised the session's spec doc (now ${publication.lineCount} lines). It now lives in the session's spec doc.`
          : `The scout investigated the repo and drafted a ${publication.lineCount}-line markdown spec. It now lives in the session's spec doc.`;
      } else {
        outcome = 'question';
        dispatchSummary = apiFailure
          ? `${describeAgentApiFailure(apiFailure)}. No spec was produced.`
          : 'The scout did not complete successfully, so no spec was produced.';
      }
    } else {
      const testing = testingNotes.extract(result.lastResultText || '');
      testing.cleanedText = proposalDescription.extract(testing.cleanedText).cleanedText;
      const hasChanges = result.ahead > 0 && !!result.sha;
      // #170: a headless session only ever has spec_md if its own scout
      // wrote it this run — so spec_md present means this build was the
      // decision turn's dispatch: success is 'spec_code', and failure
      // degrades to 'spec' (the spec is the durable artifact), not
      // 'question' like the phase-1 direct-build path.
      if (hasChanges && !result.fatalError) {
        if (testing.testingMd || testing.testingPath) {
          await pool.query(
            'UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4',
            [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
          ).catch(() => {});
          session.testing_md = testing.testingMd;
          session.testing_path = testing.testingPath;
          session.testing_paths = testing.testingPaths || [];
        }
        outcome = session.spec_md ? 'spec_code' : 'code';

        // #361/#183 parity (chat 735 / issue #370): the LIVE headless path
        // builds a staging preview and persists a `changesReady: true` system
        // message — that marker is what makes a dev chat cloned from this auto
        // session render the "Changes ready" card (Preview / Test / Propose),
        // since the clone copies this session's messages verbatim. A
        // restart-resumed run reaches the same committed-and-pushed state, so
        // it must emit the same marker; without it, a proposal interrupted by
        // a platform restart silently loses its card even though the branch
        // has a reviewable commit. Build best-effort and persist the marker
        // whether or not staging succeeds, exactly like the live path.
        const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
        let stagingResult = null;
        let stagingErr = null;
        // #461: pend the checks for the NEW commit before the build, so the
        // previous commit's verdict (e.g. a stale 'passing') can't satisfy
        // the merge gate while this build runs — or after it fails.
        await visuals.setChecksPending(pool, session.id, result.sha, 'building', 'commit-push')
          .catch((err) => log.warn('visuals', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message }));
        try {
          stagingResult = await staging.buildAndDeployStaging(config, session, app, result.sha);
        } catch (e) {
          stagingErr = e;
        }
        if (stagingResult) {
          await pool.query(
            'UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3',
            [stagingResult.containerId, stagingResult.stagingUrl, session.id]
          ).catch(() => {});
          await staging.verifyStagingEdge(session, stagingResult.hostname, stagingResult.stagingUrl).catch(() => {});
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [session.id, 'Staging preview built',
              JSON.stringify({ stagingUrl: stagingResult.stagingUrl, changesReady: true, prNumber: null })]
          ).catch(() => {});
          // Before/after visuals: best-effort, never throws. There is no turn
          // to stream to on a resumed run, so pass no `send`: the notifiers
          // then publish to the bus and the global socket for open pages.
          visuals.captureForSession(config, session, app, result.sha, stagingResult, { send: null, trigger: 'commit-push' })
            .catch((err) => log.warn('visuals', 'Resumed headless capture failed (non-fatal)', { sessionId: session.id, err: err.message }));
          dispatchSummary = `Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}, and a staging preview was built. `
            + 'Headless mode: no PR was opened (it is created on a clone at propose time).'
            + (session.spec_md ? ' The change implements the spec drafted earlier this run (in the session spec doc).' : '')
            + (testing.cleanedText ? `\n\nWhat the agent did:\n${testing.cleanedText.slice(0, 2000)}` : '');
        } else {
          const { errMsg, errName, missingKeys } = describeStagingFailure(stagingErr);
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [session.id, 'Staging build failed',
              JSON.stringify({ error: errMsg, changesReady: true, stagingFailed: true, stagingErrorName: errName, stagingMissingKeys: missingKeys, prNumber: null })]
          ).catch(() => {});
          // #461: record the failure as a terminal 'error' checks verdict
          // (with reason + once-per-streak owner nudge) instead of leaving
          // the pending state to look "still running" forever.
          await stagingRecovery.recordStagingBootFailure({ config, pool, session, commitHash: result.sha, err: stagingErr })
            .catch((e) => log.warn('staging', 'recordStagingBootFailure failed (non-fatal)', { sessionId: session.id, err: e.message }));
          log.warn('staging', 'Resumed headless staging build failed (non-fatal — commit pushed)', {
            sessionId: session.id, errName, err: errMsg, missingKeys,
          });
          dispatchSummary = `Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}. `
            + 'Headless mode: no PR was opened. The staging preview could not be built, but the commit is reviewable: the "Changes ready" card still appears on a clone.'
            + (session.spec_md ? ' The change implements the spec drafted earlier this run (in the session spec doc).' : '')
            + (testing.cleanedText ? `\n\nWhat the agent did:\n${testing.cleanedText.slice(0, 2000)}` : '');
        }
      } else {
        outcome = session.spec_md ? 'spec' : 'question';
        dispatchSummary = (result.fatalError
          ? `The coding agent hit an error: ${result.fatalError.substring(0, 200)}`
          : 'The coding agent finished without pushing any changes.')
          + (session.spec_md ? ' The spec drafted earlier this run is still the reviewable artifact.' : '');
      }
    }
    headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
  }

  // #178: a 'wrapping' checkpoint written before/during the decision turn
  // carries outcome 'spec' even when the spec still has a blocking
  // Questions section — flip it so re-running Generate proposal stays unblocked
  // (no comment is posted; the decision text died with the old process).
  if (outcome === 'spec' && specHasBlockingQuestions(session.spec_md)) {
    outcome = 'question';
  }

  // step === 'wrapping' (directly, or fallen through from cc_running).
  // OpenRouter recovery closes from the selected model's durable summary;
  // Claude recovery retains the historical Mayor wrap-up.
  if (!headlessTurnId) {
    headlessTurnId = await checkpointHeadlessWrapUp(pool, session.id, outcome);
  }
  const fallbackMayorText = outcome === 'spec'
    ? '_Spec drafted. Review it in the spec viewer after starting a session from this auto session._'
    : outcome === 'spec_code'
      ? '_Spec drafted and change committed. Start a session from this auto session to open the PR._'
      : outcome === 'code'
        ? '_Change committed and pushed. Start a session from this auto session to open the PR._'
        : "_The auto session's dispatch didn't finish successfully. See the status above._";
  let mayorText2;
  let servedModelR;
  let recoveredUsage = null;
  if (isOpenRouterSession) {
    mayorText2 = String(dispatchSummary || '').trim() || fallbackMayorText;
    servedModelR = session.agent_model ? `openrouter/${session.agent_model}` : null;
  } else {
    let recoveredWrapUpBillingAvailable = false;
    try {
      const billing = await limits.resolveBillingPath(
        pool, config.dataEncryptionKey, session.user_id,
      );
      if (!billing.error) {
        userApiKey = billing.apiKey;
        recoveredWrapUpBillingAvailable = true;
      } else {
        log.info('sessions', 'Resumed headless wrap-up using deterministic fallback', {
          sessionId: session.id, reason: billing.reason || null,
        });
      }
    } catch (err) {
      log.warn('sessions', 'Resumed headless wrap-up billing resolve failed', {
        sessionId: session.id, err: err.message,
      });
    }
    const { rows: msgRows } = await pool.query(
      `SELECT role, content FROM chat_session_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id ASC`,
      [session.id]
    );
    const convo = msgRows
      .filter((r) => (r.content || '').trim())
      .map((r) => ({ role: r.role, content: r.content }));
    convo.push({
      role: 'user',
      content: `[SYSTEM NOTE — not the human] The platform restarted while this auto session was running; it has been resumed. The dispatched work finished with outcome '${outcome}'.${dispatchSummary ? `\n\nDispatch result:\n${dispatchSummary}` : ''}\n\nWrite the final wrap-up message for the human reviewer who will pick this session up later: state what was done and what they should do next. Do not call any tools.`,
    });
    const headlessAddendum = buildHeadlessAddendum(issueNumber);
    const currentSpec = await loadSessionSpec(pool, session.id);
    const wrapPrompt = getMayorSystemPrompt(session.app_name, false, currentSpec, !!session.app_self_hosted, null) + headlessAddendum;
    const recoveredEffect = await runHeadlessMayorEffect({
      pool,
      sessionId: session.id,
      headlessTurnId,
      fallbackText: fallbackMayorText,
      allowInvoke: recoveredWrapUpBillingAvailable,
      invoke: () => llm.streamChat({
        messages: convo,
        systemPrompt: wrapPrompt,
        model: selectedModel,
        apiKey: userApiKey,
        telemetryContext: invocationTelemetry(pool, session, 'headless_wrapup'),
      }),
    });
    const mayor2 = recoveredEffect.response;
    if (mayor2.fallbackServed && recoveredEffect.disposition === 'executed') {
      await modelFallback.record(pool, {
        kind: events.EVENT_TYPES.MODEL_FALLBACK,
        userId: user.id, appId: session.app_id, sessionId: session.id,
        requested: selectedModel, served: mayor2.servedModel,
        category: (mayor2.stopDetails && mayor2.stopDetails.category) || null,
        source: 'headless-resume',
      });
    }
    mayorText2 = (mayor2.text || '').trim() || fallbackMayorText;
    servedModelR = mayor2.servedModel || selectedModel;
    recoveredUsage = mayor2.usage || null;
  }
  const costCents2 = recoveredUsage ? llm.estimateCostCents(recoveredUsage, servedModelR) : 0;
  await persistHeadlessMayorRow({
    pool,
    sessionId: session.id,
    headlessTurnId,
    text: mayorText2,
    model: servedModelR,
    usage: recoveredUsage,
    costCents: costCents2,
    // #1001: this row was the single biggest no-pills hole in production —
    // it wrote no metadata column at all, so every restart-resumed auto
    // session fell through to the client's generic default.
    metadata: headlessWrapUpMeta(outcome),
  });
  if (recoveredUsage) {
    await settleHeadlessMayorUsage({
      pool,
      userId: user.id,
      sessionId: session.id,
      headlessTurnId,
      usage: recoveredUsage,
      servedModel: servedModelR,
      selectedModel,
      userApiKey,
    });
  }

  if (recoveredJournal && recoveredTurnForCleanup) {
    recoveredTurnForCleanup = await turnLifecycle.markHeadlessTerminal(pool, {
      sessionId: session.id,
      ...turnLifecycle.cleanupArgs(recoveredTurnForCleanup),
      status: 'ready',
      outcome,
    });
  } else {
    await pool.query(
      `UPDATE chat_sessions SET headless_status = 'ready', headless_outcome = $1,
              headless_step = NULL, headless_turn_id = NULL, last_activity_at = NOW()
       WHERE id = $2`,
      [outcome, session.id]
    );
  }
  broadcastGlobal({
    type: 'session_event', sessionId: session.id, event: 'headless_update',
    status: 'ready', outcome, issueNumber, appSlug: session.app_slug,
  });
  sessionState.touch(session.id);
  // #161: a restart-resumed run completing is the same user-facing
  // moment as a live one — notify the user who started it.
  await notifyAutoSolveDone(pool, {
    userId: user.id, appId: session.app_id, sessionId: session.id, detail: outcome,
  });
  log.info('sessions', 'Headless session resumed to ready', { sessionId: session.id, issueNumber, outcome });
  if (recoveredTurnForCleanup) {
    // Release the durable record and its journal only after every recovered
    // tail step has completed. A failed clear is then safe to retry alone.
    const cleanupArgs = turnLifecycle.cleanupArgs(recoveredTurnForCleanup);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(session.id, cleanupArgs),
      cleanupArgs,
    );
  }
}

// User-facing description of a mid-turn failure, persisted as a status
// row by the chat handler's catch. Known provider failure modes get a
// readable framing; everything else passes through the raw message (it
// was already what the live 'error' event showed). Exported for tests.
function describeTurnError(err) {
  const message = String((err && err.message) || err || 'Unknown error');
  const status = err && (err.status || err.statusCode);
  if (status === 429) {
    // The platform's own daily-limit message ("Daily limit reached
    // ($20.00). Resets at midnight UTC.") is already user-readable —
    // keep it verbatim; frame opaque provider 429s as rate limiting.
    return /limit|budget/i.test(message)
      ? message
      : `The AI provider rate-limited this request: ${message}`;
  }
  if (status === 529 || /overloaded/i.test(message)) {
    return 'The AI provider is overloaded right now. Try again in a minute.';
  }
  // spawn E2BIG: the OS rejected a process launch because a single
  // argument crossed Linux's 128 KiB limit. Deterministic — a verbatim
  // retry can never succeed — so say what to change instead of parroting
  // the errno. Should be unreachable for the dispatch prompt itself now
  // that it travels as a file (worker.TURN_PROMPT_PATH), but other
  // spawns can still theoretically hit it.
  if (/\bE2BIG\b/.test(message)) {
    return 'This request was too large to hand to the coding agent. Trim the session spec or attachments before retrying';
  }
  // Cold worker bootstrap failed: the container never reached warm-ready,
  // so the coding agent was never launched and not one file was touched.
  //
  // These used to reach the user as the wrapper's raw string. "clone failed"
  // with nothing after it reads like the agent tried and gave up, names no
  // cause, and does not say the repo is untouched. Two separate sessions
  // spent real budget chasing a GitHub authentication problem that never
  // existed, because the words were all the evidence anyone had.
  if (worker.isBootstrapError(err)) {
    // Everything after the first colon is git's own stderr, forwarded by
    // worker-run.sh's `die`. Absent on the timeout paths, and absent on a
    // warm container still running an image from before that change.
    const colon = message.indexOf(':');
    const detail = colon === -1 ? '' : message.slice(colon + 1).trim();
    const git = detail ? ` Git reported: ${detail}` : '';
    if (message.startsWith('clone failed')) {
      return 'Setting up the coding agent failed while cloning the repository, so the agent never started and no code was changed.'
        + `${git} The platform already retried this a few times, so if it keeps happening the repository or the network is genuinely unreachable rather than briefly flaky.`;
    }
    if (message.startsWith('checkout failed')) {
      return 'Setting up the coding agent failed while checking out this session\'s branch, so the agent never started and no code was changed.'
        + `${git} Retrying will not help until the branch problem is resolved.`;
    }
    if (message.startsWith('warm-ready timeout')) {
      return 'Setting up the coding agent timed out before it was ready, so the agent never started and no code was changed. Try again in a minute.';
    }
    if (/exceeded quota/i.test(message)) {
      return 'Setting up the coding agent failed because the platform has no free workspace storage for coding agents right now, so the agent never started and no code was changed. '
        + 'Space frees up as other changes merge, close or sit idle; try again in a few minutes.';
    }
    return 'Setting up the coding agent stopped unexpectedly before it was ready, so the agent never started and no code was changed. Try again, and if it keeps happening the platform log for this session holds the container output.';
  }
  return message;
}

// Short, human-readable label for a Claude model id. Used in
// user-facing status lines (e.g. "Spinning up coding agent (Opus
// 4.6)..."). Falls back to the raw id so unknown/new model slugs at
// least show something identifiable rather than a blank parenthetical.
function prettyModelLabel(modelId) {
  if (!modelId) return 'Sonnet';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('haiku')) return 'Haiku';
  if (modelId.includes('sonnet')) return 'Sonnet';
  return modelId;
}

// Model ids are execution data, but they are also interpolated into a few
// trusted server-authored status strings that the legacy client renders as
// HTML. Keep the exact id in runtime metadata and billing while limiting the
// display copy to the punctuation OpenRouter model ids actually use. This
// prevents a provider catalog entry from becoming markup in the transcript.
function safeAgentModelLabel(modelId, fallback = 'model not configured') {
  const raw = String(modelId || '').trim();
  if (!raw) return fallback;
  const safe = raw.slice(0, 200).replace(/[^A-Za-z0-9._:/+@~-]/g, '?');
  return safe || fallback;
}

// One provider-neutral identity for every coding-agent runtime surface.
// Execution, progress, transcript labels, and usage reporting must all use
// the session-pinned model; deriving these independently is what previously
// let a Codex turn be displayed and billed under the Mayor's Claude model.
// The selectedModel fallback is intentionally Claude-only. A malformed
// legacy Codex row without a pinned/operator model remains unconfigured and
// is rejected by resolveCodexRuntimeContext instead of masquerading as a
// Claude-model Codex run.
function codingAgentRuntimeIdentity(session, selectedModel, config = {}) {
  const backend = registry.resolveBackend(session?.agent_backend);
  const isCodex = backend === 'codex_openrouter';
  const model = isCodex
    ? (session?.agent_model || config.openrouterDefaultCodexModel || null)
    : selectedModel;
  // #3296: which CLI an OpenRouter turn runs in, from the same per-model map
  // the dispatch reads, so the transcript names the agent that actually ran.
  // Rows carry it only for the exception, Claude Code: every reader treats a
  // row without it as Codex, which is what every earlier OpenRouter row was.
  const harness = isCodex ? registry.openRouterHarnessForModel(model, config) : null;
  return {
    backend,
    isCodex,
    harness,
    model,
    modelLabel: isCodex
      ? safeAgentModelLabel(model)
      : safeAgentModelLabel(prettyModelLabel(selectedModel), 'Sonnet'),
    agentName: isCodex ? 'OpenRouter' : 'Claude Code',
    metadata: {
      agentBackend: backend,
      agentModel: model || null,
      ...(harness === 'claude' ? { agentHarness: harness } : {}),
    },
  };
}

// A headless dispatch cannot move on to its independently identified Mayor
// wrap-up while the coding owner is only *partly* released. If cleanup cannot
// commit, retain both durable records and let the recovery scheduler finish
// the handoff. Ordinary non-headless callers preserve the historical
// best-effort cleanup behavior; interactive dispatches defer cleanup until
// their own wrap-up and therefore do not call this helper here.
async function finishToolTurnCleanup(sessionId, turnId, { required = false } = {}) {
  const cleared = await worker.finishTurn(sessionId, { turnId }).catch(() => false);
  if (required) {
    recoveryRetry.requireDurableTurnCleanup(cleared, { turnId });
  }
  return cleared;
}

// Runs Claude Code in read-only PLAN MODE (the spec-stage scout). CC
// reads the repo and produces a markdown spec as its final result text;
// we capture that into chat_sessions.spec_md. No commit, no push, no
// staging rebuild — by design, scout is structurally forbidden from
// editing anything. Mirrors runClaudeCodeTool's stop / progress / cost-
// tracking shape so the existing client SSE handlers don't have to
// special-case scout vs. build.
// #1350 backstop: no dispatch can run without a branch.
//
// The first-turn mint in POST /chat covers every interactive path and
// headless runs mint their own up front, so by the time a dispatch reaches
// this the branch is normally already on the row and this is one indexed
// SELECT. It exists anyway because the consequence of dispatching without
// one is not a poor error message: worker-run.sh hard-requires BRANCH, and
// once a worker is warm on a bad value run-cc.sh dies on
// "branch missing upstream: origin/$BRANCH" for every build and sync turn
// after it, with no way back. Mint rather than dispatch into that.
//
// Deliberately unconditional on runLocally: a local agent commits on the
// user's machine but pushes through the platform, so it needs the ref too.
async function ensureBranchForDispatch(pool, session) {
  if (session.branch_name) return session.branch_name;
  const ensured = await sessionLifecycle.ensureSessionBranch({
    pool, sessionId: session.id,
  });
  session.branch_name = ensured.branchName;
  return ensured.branchName;
}

async function runScoutTool({
  pool, config, req, res, session, selectedModel,
  userMessage, toolPromptArg,
  // #450: pre-rendered "==== USER-ATTACHED FILES ====" block for the
  // current turn (text files inlined, images via usernode-attachments).
  // '' when the turn carried no attachments (incl. every headless path).
  attachmentsBlock = '',
  // #945: pre-rendered "==== DISCUSSION ON THIS WORK ====" block (the
  // issue / proposal Discussion threads). '' on the headless path — the
  // seed there already carries the same discussion, and this is passed
  // `userMessage`, so injecting it again would just duplicate it.
  discussionBlock = '',
  repoOwner, repoName,
  send, sendStatus,
  stopHandle,
  userApiKey,
  headless = false,
  // Interactive callers own the Mayor phase-2 wrap-up and therefore keep
  // this turn's durable record until that final tail is committed. A headless
  // caller supplies beforeTurnCleanup to checkpoint the next paid Mayor phase
  // (and its stable receipt id) before this per-dispatch owner is released.
  deferTurnCleanup = false,
  beforeTurnCleanup = null,
}) {
  activeWorkers.add(session.id);
  // #50: wall-clock start for the durationMs persisted on terminal
  // statuses, so the dev-chat "(took Xm Ys)" suffix survives reloads.
  const turnStartedMs = Date.now();
  // Backend-aware model + secret (review F2, F10). Codex sessions use the
  // exact pinned OpenRouter model and NO Anthropic key. Keep every runtime
  // label/metadata consumer on this same identity so the Mayor's Claude model
  // can never leak into Codex progress or usage.
  const agentIdentity = codingAgentRuntimeIdentity(session, selectedModel, config);
  const {
    isCodex: isCodexSession,
    model: turnModel,
    modelLabel,
  } = agentIdentity;
  const turnApiKey = isCodexSession ? null : (userApiKey || null);
  let durableTurnId = null;

  // #937: the single way this tool ends on a stop, used by every
  // pre-dispatch gate below AND by the post-run branch, so the two can't
  // drift in wording, pills or duration.
  //
  // It does its own teardown because the gates fire on both sides of the
  // big `try` further down: the ones before it (spin-up, ensureWorker,
  // syncUserAgentFiles) would otherwise skip that try's `finally`. Every
  // step here is idempotent, so a gate INSIDE the try double-running it
  // via the finally is a no-op.
  const stoppedResult = async () => {
    const byStr = stopHandle?.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
    // #894: the caller skips the phase-2 wrap-up after a stop (nothing
    // coherent to summarize) and phase-1's pills were already dropped
    // because a dispatch co-occurred — so this row carries them. The
    // 'stopped' outcome is state-independent, hence no hasPr/hasSpec.
    await sendStatus(`Scout stopped${byStr}.`, {
      ...agentIdentity.metadata,
      durationMs: Date.now() - turnStartedMs,
      // The scout writes the spec doc and commits nothing, so its landing is
      // always empty — but it still carries the marker, because that is what
      // moves the row off the pipeline's green ✓ and onto the stopped card.
      stopLanding: stopLandingMeta({ headline: `Scout stopped${byStr}` }),
      quickReplies: turnFallbackQuickReplies({ outcome: 'stopped' }),
    });
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    // NOT worker.finishTurn: releasing the held turn record stays the
    // exclusive job of the `finally` below (tests/turn-tail-lifecycle
    // pins that). A gate that fires before the dispatch never held one in
    // the first place, and a gate inside the try reaches that finally.
    return {
      toolResultText: `The scout was stopped${byStr} before it finished. The spec doc was not updated.`,
      isError: true,
      turnId: durableTurnId,
    };
  };

  // #937 gate 1 of 5 — entry. A stop that landed while the Mayor was still
  // deciding (or in the awaited gap between the end of its stream and
  // `setPhase('cc')`) must not buy the user a whole scout run.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // #616: read-only prod-debug access for admin-owned sessions on the
  // self-edit app. Checked fresh per turn (admin revocation takes effect
  // on the next dispatch; the internal routes re-check per request too).
  // Failure means no access — never a failed turn.
  let prodDebug = false;
  try {
    prodDebug = await debugAccess.isEligible(pool, session.id);
  } catch (err) {
    log.warn('sessions', 'Prod-debug eligibility check failed (continuing without)', {
      sessionId: session.id, err: err.message,
    });
  }
  // #907: a scout turn follows the same "Run on" choice a build turn does —
  // the selector's state IS the lease, so there is no separate flag to thread
  // through. If a machine is attached to this session, the spec gets drafted
  // there, by the user's own Claude, against their own checkout.
  //
  // Never for headless turns, same reasoning as the build path: an unattended
  // issue-triage run must not wait 90 seconds on a laptop nobody is watching.
  // A lookup failure means "no local agent", never a failed turn.
  let lease = null;
  if (!headless && !isCodexSession) {
    try {
      lease = await localAgent.activeLease(pool, session.id);
    } catch (err) {
      log.warn('sessions', 'Local agent lease lookup failed (using worker)', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  const runLocally = !!lease;
  // A local lease is explicitly the user's own Claude runtime, regardless of
  // which cloud backend this session has pinned for platform turns.
  const executionAgentMeta = runLocally
    ? { agentBackend: 'claude_code', agentModel: null }
    : agentIdentity.metadata;
  // Prod-debug access is deliberately cloud-only (the spec's "a local turn
  // never receives PROD_DEBUG_JWT"). Clear the flag rather than only omitting
  // the credential, so the prompt does not advertise a `usernode-debug` helper
  // the local machine has no way to authenticate.
  if (runLocally) prodDebug = false;
  await sendStatus(
    runLocally
      // No model label: the local runtime uses whatever model the user's own
      // Claude Code is configured for, and claiming ours would be a lie.
      ? `Scouting on ${lease.label}: your machine, read-only${discussionBlock ? ' · with issue & proposal discussion' : ''}...`
      : `Scouting the repo for context (${modelLabel}${prodDebug ? ' · prod debug' : ''}${discussionBlock ? ' · with issue & proposal discussion' : ''})...`,
    runLocally
      ? {
          ...executionAgentMeta,
          runner: 'local', localAgentLabel: lease.label, localMode: 'scout',
        }
      : executionAgentMeta
  );

  // A local scout needs no worker image, no warm container and no CC volume:
  // the checkout and the model call both live on the user's machine.
  if (!runLocally) await worker.ensureWorkerImage();

  // #937 gate 2 of 5 — after the image pull.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // When a spec already exists, this scout run is a REVISION: the scout
  // sees the current doc verbatim and outputs a full revised document,
  // preserving accepted content. This replaced the Mayor's old
  // in-process write_spec/edit_spec tools (#111) — Claude Code does a
  // much better job at spec drafting and revision than the Mayor did.
  const existingSpec = (await loadSessionSpec(pool, session.id)).trim();
  const revisionBlock = existingSpec
    ? `

This session ALREADY HAS a spec doc, shown verbatim below. Your task is a REVISION of it, not a from-scratch rewrite: apply the requested changes, keep everything else intact (the user may have already reviewed and accepted the rest), and re-verify against the repo only where the change requires it. Your final message must be the COMPLETE revised spec document — it replaces the doc wholesale. If the existing spec does not follow the two-section structure mandated below ("## User-facing changes" / "## Technical implementation"), reorganize it into those two sections as part of this revision while preserving its content.

==== CURRENT SPEC DOC (revise this) ====

${existingSpec}

==== END CURRENT SPEC DOC ====`
    : '';

  // #460: the dispatching user's personal agent files — same load as the
  // build path (see runClaudeCodeTool). Synced into the CC volume after
  // ensureWorker below; the one-line prompt pointer only appears when
  // files exist. Non-fatal on any failure.
  //
  // Skipped for a local run (#907): the user's own ~/.claude already holds
  // these on the machine about to run the turn, and that is their filesystem.
  let personalFiles = [];
  try {
    if (session.user_id && !runLocally) {
      personalFiles = await userAgentFiles.loadAllForUser(pool, session.user_id);
    }
  } catch (err) {
    log.warn('sessions', 'Personal agent files load failed (continuing without)', { sessionId: session.id, err: err.message });
  }
  const personalFilesNote = personalFiles.length
    ? `

PERSONAL AGENT FILES: the user who dispatched this run has personal instruction files (already loaded for you at \`~/.claude/CLAUDE.md\`) and/or personal skills (under \`~/.claude/skills/\`). Honor them as the dispatching user's personal preferences when writing this spec, wherever they don't conflict with platform rules or the repo's own \`CLAUDE.md\` on app-specific matters.`
    : '';

  // #907: `usernode-issues` is a helper the worker image installs. A local
  // scout runs on the user's own machine, where it does not exist — so the
  // paragraph offering it is dropped rather than sending the agent after a
  // command it cannot run. The issue's own Discussion thread still reaches it
  // through discussionBlock, which is where the answers usually are.
  const issueHelperNote = runLocally
    ? ''
    : `
A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`); long bodies are clipped with a "[truncated …]" marker, and \`usernode-issues <number>\` fetches that one issue with its FULL body plus BOTH of its discussion surfaces (\`{ issue, comments, commentsTruncated, usernodeThread?, usernodeThreadTruncated?, note? }\` — \`comments\` are the GitHub comments, \`usernodeThread\` is the issue's Discussion thread on the platform, where people often answer clarifying questions). Use it if the open issues are relevant context for this spec; do not try to reach GitHub any other way. ${SCREENSHOT_FETCH_NOTE}
`;

  // Claude's scout reads with Read/Glob/Grep and run-cc.sh strips its edit
  // tools. A Codex scout reads through shell commands and has no such switch,
  // so it is told plainly, and the runner puts back anything it changes
  // (worker/run-codex-agent.sh restore_scout_tree, #2810). An OpenRouter
  // model that runs in Claude Code (#3296) has Claude's tools and switch.
  const scoutPlanModeLine = isCodexSession && agentIdentity.harness !== 'claude'
    ? 'You are running in PLAN MODE: read and search the repository with read-only shell commands (for example `rg`, `ls`, `sed -n`, `cat`), but do not edit, create, delete, commit, or push anything. Do not attempt to: anything this run changes in the repository is discarded when it ends.'
    : 'You are running in PLAN MODE: you can read files (Read, Glob, Grep) but you cannot edit, commit, or push anything. Do not attempt to.';
  // #2817: every scout settles the design decisions in the spec.
  const scoutDesignBrief = `\n- ${SPEC_DESIGN_BRIEF}`;

  // Scout-specific prompt. Deliberately omits the platform-conventions
  // block and commit/push instructions used in the build prompt — scout
  // never edits anything. The "final message is the spec" contract is
  // load-bearing: we extract `result.lastResultText` verbatim and store
  // it as spec_md, so any preamble would leak into the user's spec.
  const scoutPrompt = `SCOUT TASK (from the Mayor):
${toolPromptArg}

USER REQUEST: "${userMessage}"${attachmentsBlock}${discussionBlock}

${scoutPlanModeLine}${personalFilesNote}${revisionBlock}
${issueHelperNote}${runLocally ? '' : `\n${HOMEROOM_READ_NOTE}\n`}${prodDebug ? `
${debugAccess.promptBlock()}
` : ''}
Your job is to investigate this repo and produce a MARKDOWN SPEC for the change. The spec should be:
- A complete, self-contained markdown document the user can review on its own.
- Grounded in real file evidence — reference actual file paths and current behaviour, not guesses.
- Structured as TWO halves under these exact H2 headings, in this order: "## User-facing changes" then "## Technical implementation". The spec viewer renders the two halves as tabs, so content outside them is undesirable — keep everything except the title and an optional 1-2 sentence summary inside one of the two halves. "User-facing changes" must be readable by a non-developer: describe what the user will see and do differently (screens, behaviour, before/after) — no file paths, no schema, no code. "Technical implementation" holds everything else: affected files, data model, edge cases, tests, considerations, deferred work. All other headings must be ### or deeper — no other ## headings anywhere in the document.
- Specific enough that a coding agent could implement it without re-doing your investigation, but NOT a literal diff or code block.
- If the planned change introduces data-dependent UI (lists, threads, leaderboards, anything that renders rows), the "Technical implementation" half should name the staging seed data the build will need (per the "Staging mock data" platform convention), so seeding is planned rather than improvised at build time.${scoutDesignBrief}

The spec is rendered as markdown in a viewer that follows standard CommonMark fencing. If you include a fenced code block that ITSELF contains a triple-backtick fence (common when quoting markdown examples or the platform's \`\`\`filepath:...\`\`\` output convention), wrap the OUTER block in a four-backtick fence (\`\`\`\`) — a longer fence can safely contain shorter ones. Otherwise the inner \`\`\` closes the block early and the rest of the spec renders broken. When in doubt, prefer fewer/inline code samples over deeply nested fences.

Do NOT pad the spec with open questions. Only include a "### Questions" subsection — placed at the END of the "User-facing changes" half, since questions are for the (possibly non-technical) requester — for things that genuinely BLOCK implementation: decisions the coding agent cannot reasonably make on its own and that would change what gets built. Make a sensible default choice wherever you can and state it, rather than asking. Non-blocking items — things worth noting but not required to answer before building — belong in the "Technical implementation" half under "### Considerations" (trade-offs, assumptions, things to keep in mind) or "### Deferred work" (out-of-scope or follow-up items), NOT as questions. When there are no blockers, OMIT the "### Questions" subsection entirely — do NOT write "### Questions\nNone" or an empty section.

Your final assistant message must be ONLY the markdown spec — no preamble, no "I'll investigate...", no "Here's the spec:". The host captures that final message verbatim and stores it as the session's spec doc.

CRITICAL: Output the spec as RAW markdown. Do NOT wrap your whole response in a code fence — no leading \`\`\`markdown line and no trailing \`\`\`. A whole-document fence makes the spec render as one big code block instead of formatted markdown. Fences are only for actual code/quoted snippets INSIDE the spec.${headless ? `

HEADLESS RUN (#178): this spec is being drafted unattended for a GitHub issue — no human is available to answer questions during the run. If the Mayor's instructions list ambiguities or unresolved points, resolve them from the code BEFORE considering them open: read the relevant files, state what the code shows, and choose a sensible default where one exists. Any "### Questions" section you do write (at the end of the "User-facing changes" half) will be relayed verbatim to the issue reporter as a GitHub comment, so it must contain ONLY questions a codebase cannot answer (product intent, preferences, reproduction details), each self-contained, numbered, and carrying your suggested default.` : ''}`;

  // Ensure the long-lived worker is warm before exec'ing run-cc.sh inside
  // it. Cold-start cost (clone + checkout + sleep wrapper) is paid here on
  // the first dispatch of a session; subsequent ensures are sub-second.
  // Bootstrap progress (clone/checkout/warm-ready) flows through onProgress
  // to the dev-chat UI just like the legacy single-shot path used to.
  await ensureBranchForDispatch(pool, session);
  let containerName = null;
  if (!runLocally) {
    try {
      containerName = await worker.ensureWorker(session.id, {
        repoOwner,
        repoName,
        branchName: session.branch_name,
        onProgress: (text) => {
          send('cc_progress', { text, ...agentIdentity.metadata });
          workerProgress.set(session.id, text, {
            model: turnModel,
            backend: agentIdentity.backend,
          });
        },
      });
    } catch (err) {
      // Nothing was dispatched, so there is no turn to terminalize and no
      // work to summarize. Hand the reason back to the Mayor.
      return await workerBootstrapFailureResult(err, {
        session,
        send,
        sendStatus,
        statusMeta: {
          ...agentIdentity.metadata,
          durationMs: Date.now() - turnStartedMs,
        },
        durableTurnId,
      });
    }
  }

  // Surface the warm container name for diagnostics. The actual stop
  // signal travels through worker.stopTurn (in-container pkill) so the
  // warm container survives stop and the next dispatch is fast.
  if (stopHandle) stopHandle.workerName = containerName;

  // #937 gate 3 of 5 — after ensureWorker. This is the WIDEST window: a
  // cold session clones + checks out the repo here, which can take tens of
  // seconds, and it sits entirely between "Scouting the repo…" and the
  // dispatch.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // #460: wipe-and-rewrite the personal agent files in the CC volume —
  // runs even with an empty list so Settings deletions take effect on
  // the next dispatch. Never fails the scout turn. There is no CC volume
  // for a local run, so it is skipped entirely.
  try {
    if (!runLocally) await worker.syncUserAgentFiles(session.id, personalFiles);
  } catch (err) {
    log.warn('sessions', 'Personal agent files sync failed (continuing without)', { sessionId: session.id, err: err.message });
  }

  // #937 gate 4 of 5 — after the personal-files sync.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  let isError = false;
  const summaryParts = [];
  // Once dispatch begins, an exception means the durable tail must remain
  // replayable. Normal/handled exits flip this back only after every required
  // tail effect has landed.
  let durableTailComplete = true;

  try {
    // #937 gate 5 of 5 — immediately before the dispatch. Placed ahead of
    // the "Scout reading the codebase…" status AND the progress-row INSERT
    // so a stopped-at-spin-up turn leaves neither a status claiming the
    // scout ran nor an empty progress card in the transcript.
    if (stopPendingFor(stopHandle)) return stoppedResult();

    await sendStatus('Scout reading the codebase...', executionAgentMeta);

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 5000);

    // Persist a `'Claude Code progress'` system message and
    // incrementally append onProgress lines to its
    // metadata.progressLog. Mirrors the build-path persistence in
    // runClaudeCodeTool so that on page reload (or any re-fetch of
    // messages), the scout progress log still renders inline under
    // the "Scout reading the codebase…" status. Without this, progress
    // was SSE-transient — visible during the live turn, gone on the
    // next message reload — which the dev-chat UI surfaced as a
    // separate "Claude Code output" block that "disappeared after it
    // is done". The client pairs this row with the preceding scout
    // status line via the same pre-pass that handles build's
    // "Claude Code is running…" pairing.
    const { rows: progRows } = await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
      [session.id, JSON.stringify({ progressLog: [], ...executionAgentMeta })]
    );
    const progressMsgId = progRows[0].id;

    const onScoutProgress = (text) => {
      send('cc_progress', { text, ...executionAgentMeta });
      workerProgress.set(session.id, text, {
        model: executionAgentMeta.agentModel,
        backend: executionAgentMeta.agentBackend,
      });
      pool.query(
        `UPDATE chat_session_messages SET metadata = jsonb_set(
          metadata, '{progressLog}',
          (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
        ) WHERE id = $2`,
        [JSON.stringify([text]), progressMsgId]
      ).catch(() => {});
    };

    // #907: hand the scout turn to the attached machine and wait, then shape
    // the answer like an execInWorker scout result so everything below —
    // spec persist, the frozen version snapshot, the spec_updated event, the
    // Mayor wrap-up — runs byte-identically.
    //
    // The one thing this deliberately does NOT do is anything the build path
    // does after a commit: no head SHA, no push heal, no staging build, no
    // checks, no visuals, no PR metadata. A scout turn is read-only, and the
    // absence of that whole tail is the feature, not an omission.
    let seenScoutLines = 0;
    const localScoutCorrelationId = crypto.randomUUID();
    let localScoutAttemptNumber = 0;
    const dispatchLocalScout = async () => {
      // This is the read-only completion path: it returns no commit, no push
      // flag and no branch movement, so the caller's shared tail has nothing
      // to push, no preview to build and no checks to run. A scout turn
      // produces a document, and that is the whole of its output.
      const queued = await localAgent.enqueueTurn(pool, {
        sessionId: session.id,
        userId: session.user_id,
        prompt: scoutPrompt,
        // The base the reading has to be done against. A scout never commits,
        // but reading the WRONG revision produces a spec about code that is
        // not there, which is worse than a refusal.
        baseSha: session.checks_commit_sha || null,
        branchName: session.branch_name,
        mode: 'scout',
      });
      // The lease lapsed between the routing decision above and here.
      if (!queued) {
        return {
          exitCode: 1,
          ccIsError: true,
          fatalError: `${lease.label} disconnected before this turn started`,
          lastResultText: '',
          sessionId: null,
          initSessionId: null,
          markerlessCause: null,
          localTurnId: null,
          localOutcome: 'abandoned',
        };
      }
      const turnId = queued.turn.id;
      const telemetryStartedAt = new Date();
      localScoutAttemptNumber += 1;
      if (stopHandle) stopHandle.localTurnId = String(turnId);
      let announcedAccepted = false;
      const { outcome, turn: finished } = await localAgent.awaitTurnResult(pool, turnId, {
        onProgress: (row) => {
          if (!announcedAccepted && row.status !== 'queued' && row.status !== 'offered') {
            announcedAccepted = true;
            onScoutProgress(`[${lease.label} accepted the scout turn]`);
          }
          const lines = Array.isArray(row.progress) ? row.progress : [];
          for (const line of lines.slice(seenScoutLines)) onScoutProgress(line);
          seenScoutLines = Math.max(seenScoutLines, lines.length);
        },
      });
      recordLocalCodingInvocation(pool, {
        session,
        turnId,
        turn: finished,
        outcome,
        component: headless ? 'coding_agent_headless' : 'coding_agent_scout',
        attemptNumber: localScoutAttemptNumber,
        correlationId: localScoutCorrelationId,
        startedAt: telemetryStartedAt,
      });
      const explain = {
        declined: `${lease.label} declined this turn`,
        abandoned: `${lease.label} disconnected before finishing this turn`,
        stopped: 'Stopped',
        missing: 'The local turn record disappeared',
        aborted: `${lease.label} was interrupted`,
      }[outcome] || null;
      const detail = finished?.error_detail ? `: ${finished.error_detail}` : '';
      return {
        exitCode: outcome === 'completed' ? 0 : 1,
        ccIsError: outcome !== 'completed',
        fatalError: explain ? `${explain}${detail}` : null,
        // The spec IS the result text here. spec_md is the column the local
        // agent posts its drafted document into; `summary` carries the
        // runtime's own closing words, which for a scout run are the spec
        // again, so prefer the explicit field.
        lastResultText: finished?.spec_md || finished?.summary || '',
        rawStderr: finished?.error_detail || '',
        // A local run has no cost to the platform. Leaving costUsd absent is
        // what makes the zero-cost accounting below a no-op rather than a
        // special case: no llm_usage row, no settleTurnSpend, no usage event.
        sessionId: null,
        initSessionId: null,
        markerlessCause: null,
        localTurnId: String(turnId),
        localOutcome: outcome,
      };
    };

    let result;
    let codexCtx = null;
    durableTailComplete = false;
    try {
      const resumeThreadId = isCodexSession ? (session.agent_thread_id || null) : (session.cc_session_id || null);
      // Shared dispatcher for BOTH the Codex attempt loop and the Claude
      // fallback, so the expensive execInWorker options (holdTurnRecord,
      // onProgress) live in exactly one place per tool.
      const claudeTelemetryCorrelationId = crypto.randomUUID();
      let claudeTelemetryAttemptNumber = 0;
      const doScout = (ctx) => {
        const isClaudeDispatch = !ctx || !ctx.logicalTurnId;
        if (isClaudeDispatch) claudeTelemetryAttemptNumber += 1;
        return worker.execInWorker(session.id, {
          mode: 'scout',
          prompt: scoutPrompt,
          model: turnModel,
          commitMsg: '',
          resumeSessionId: resumeThreadId,
          branchName: session.branch_name,
          ...(ctx || {}),
          prodDebug,
          telemetryComponent: headless ? 'coding_agent_headless' : 'coding_agent_scout',
          telemetryCorrelationId: isClaudeDispatch ? claudeTelemetryCorrelationId : null,
          telemetryAttemptNumber: isClaudeDispatch ? claudeTelemetryAttemptNumber : null,
          // Hold the durable turn record through this tool's own tail
          // (spec persist + frozen version + Mayor wrap-up). Short, but the
          // same restart shape loses it — see the "Post-agent TAIL" note in
          // services/worker.js. Released by finishTurn in the finally below.
          holdTurnRecord: true,
          onProgress: onScoutProgress,
        });
      };
      // #1204: a dropped API stream ends the run "successfully" — exit 0,
      // __USERNODE_RESULT__ written — with the failure notice as the agent's
      // FINAL message, which for a scout IS the spec. It is retried like a
      // markerless death, but deliberately NOT only when headless: the
      // reported symptom is an interactive one, a scout is read-only so
      // re-running it changes nothing, and the alternative is the user
      // retyping the same request. Returns the status line to show, or null
      // for "do not retry", so all three dispatch paths below — local, the
      // Codex attempt ledger, and the legacy Claude one — share one rule and
      // each still names the reason it is retrying.
      const scoutRetryStatus = (r) => {
        if (headless && shouldRetryHeadlessTurn(r, stopHandle, !!(r?.lastResultText || '').trim())) {
          return 'The coding step failed unexpectedly, retrying once…';
        }
        if (codexMaxTokensRetry(r, stopHandle)) {
          return 'Your OpenRouter credit only covers a shorter reply. Retrying once with a smaller reply limit…';
        }
        if (shouldRetryApiErrorTurn(r, stopHandle)) {
          return 'The coding agent lost its connection to the API, retrying once…';
        }
        return null;
      };
      if (runLocally) {
        // Local turns do not enter the platform's Codex attempt ledger and a
        // retry must stay on the same attached machine.
        result = await dispatchLocalScout();
        const localRetryStatus = scoutRetryStatus(result);
        if (localRetryStatus) {
          await sendStatus(localRetryStatus, executionAgentMeta);
          await waitForTurnStopped(session.id, containerName);
          result = await dispatchLocalScout();
        }
      } else {
        // Backend-aware per-attempt dispatch (plan §7): for a Codex session
      // this resolves the runtime context ONCE, then starts/completes one
      // agent_turns attempt per physical worker.execInWorker (a headless
      // auto-retry gets attempt_number=2, never overwriting attempt 1). For
      // a Claude session the helper returns null and we fall through to the
      // legacy path below. plan.md PR5/PR6.
      const routed = await runCodexAttemptLoop({
        pool, session, userId: req.user.id, config, isCodexSession,
        turnModel, resumeThreadId, mode: 'scout',
        telemetryComponent: headless ? 'coding_agent_headless' : 'coding_agent_scout',
        resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
          pool, session, userId: req.user.id, model: turnModel,
          resumeThreadId, config,
          // #3296: the platform's per-model choice of CLI.
          harness: 'auto',
        }),
        dispatchOnce: (ctx) => doScout(ctx),
        // Returns the status line rather than a bare boolean, so the loop
        // says which failure it is retrying (#1204).
        retryPredicate: (r) => scoutRetryStatus(r),
        sendStatus: async (msg) => { await sendStatus(msg, executionAgentMeta); },
        waitForStopped: waitForTurnStopped,
        prepareRetry: async (retry) => {
          if (stopPendingFor(stopHandle)) return false;
          if (retry.retryFresh) {
            await worker.markTurnRetryPending(session.id, {
              turnUuid: retry.attempt.turnUuid,
              logicalTurnId: retry.logicalTurnId,
              attemptNumber: retry.attemptNumber,
            });
          } else {
            if (!retry.result?.turnId
                || !await worker.finishTurn(session.id, { turnId: retry.result.turnId })) return false;
          }
          // The required DB write / journal cleanup above yields. Re-check
          // before resetting the old attempt's stop marker so a stop that
          // landed in that window remains authoritative for attempt two.
          if (stopPendingFor(stopHandle)) return false;
          worker.clearPendingStop(session.id);
          return true;
        },
        classifyAttemptStatus: ({ failed }) => stopPendingFor(stopHandle)
          ? 'cancelled'
          : (failed ? 'failed' : 'completed'),
        containerName,
      });

      if (routed?.error) {
        codexCtx = { error: routed.error };
        durableTurnId = routed.logicalTurnId || null;
        isError = true;
        // SSE is already open; terminate through the SSE protocol (review #5)
        // instead of res.json (which would throw ERR_HTTP_HEADERS_SENT or
        // inject JSON into the stream). Mark the stop handle so the caller's
        // stop branch tears the turn down cleanly and skips the Mayor wrap-up.
        const code = routed.error;
        const msg = code === 'backend_disabled' || code === 'backend_not_available'
          ? 'OpenRouter is not available for your account right now.'
          : code === 'model_required'
            ? 'Pick an OpenRouter model in Settings for this session.'
            : code === 'invalid_base_url'
              ? 'The OpenRouter endpoint is misconfigured.'
              : code === 'ledger_start_failed'
                ? 'Could not start the OpenRouter turn. Please retry.'
                : code === 'agent_context_changed'
                  ? 'The agent configuration changed while starting this turn. Please retry.'
                  : code === 'session_busy'
                    ? 'The session became busy. Stop the current turn before retrying.'
                    : 'Add your OpenRouter API key in Settings to use OpenRouter.';
        await sendStatus(msg, executionAgentMeta);
        if (stopHandle) {
          stopHandle.stopped = true;
          stopHandle.stoppedBy = 'agent_error';
        }
        if (typeof send === 'function') send('error', { code, error: msg });
        durableTailComplete = true;
        return { toolResultText: msg, isError: true, turnId: durableTurnId };
      }
      // For a Claude session (routed === null) keep the legacy combined path
      // exactly as before (shared dispatcher above).
      if (routed === null) {
        // Claude session — legacy combined path (no agent_turns ledger),
        // but keep the headless auto-retry that the Codex loop provides
        // for its own attempts (one extra dispatch, never more).
        result = await doScout({});
        const claudeRetryStatus = scoutRetryStatus(result);
        if (claudeRetryStatus) {
          await sendStatus(claudeRetryStatus, executionAgentMeta);
          await waitForTurnStopped(session.id, containerName);
          if (!result.turnId || !await worker.finishTurn(session.id, { turnId: result.turnId })) {
            throw new Error('Could not durably finish the first scout attempt before retry');
          }
          result = await doScout({});
        }
      } else {
        result = routed.result;
      }
      }
    } catch (e) {
      // A thrown dispatch must still terminalize any Codex ledger attempt
      // (review P1): runCodexAttemptLoop completes each attempt in its own
      // try/finally, and a throw after dispatch already left the attempt
      // failed. If an attempt started but completion threw, force one
      // failed pass here as a backstop (idempotent).
      throw e;
    } finally {
      clearInterval(heartbeat);
    }

    durableTurnId = result?.turnId || null;

    // Same cc_session_id thread-through as runClaudeCodeTool — a scout
    // call early in the session is remembered when the user later
    // dispatches a real build, which keeps the spec ↔ implementation
    // mapping coherent and avoids paying full repo-read cost twice.
    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
        [newCcId, session.id]
      ).catch(() => {});
      session.cc_session_id = newCcId;
    }
    // Persist the Codex thread id for resume on the next turn (review F5).
    // For Codex the thread id comes from __USERNODE_RESULT__ agent_thread_id
    // (parsed by worker.js parseLine into state.agentThreadId).
    const newAgentThreadId = result.agentThreadId || null;
    if (newAgentThreadId && newAgentThreadId !== session.agent_thread_id) {
      await pool.query(
        'UPDATE chat_sessions SET agent_thread_id = $1 WHERE id = $2',
        [newAgentThreadId, session.id]
      ).catch(() => {});
      session.agent_thread_id = newAgentThreadId;
    }

    // #937: the post-run stop, now sharing stoppedResult() with the five
    // pre-dispatch gates so the wording, pills and duration can't drift.
    if (stopPendingFor(stopHandle)) {
      isError = true;
      durableTailComplete = true;
      return stoppedResult();
    }

    const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());
    // #1204: after the retry above, is the final message STILL a transport
    // failure notice rather than a spec?
    const apiFailure = agentApiFailure(ccText);

    if (result.fatalError) {
      isError = true;
      const msg = `Scout error: ${result.fatalError.substring(0, 200)}`;
      await sendStatus(msg, turnFailure(executionAgentMeta));
      summaryParts.push(msg);
    } else if (apiFailure) {
      // #1204: the run "succeeded" — exit 0, result line written — but the
      // agent's last words are the failure, so there is no spec here. Leave
      // spec_md alone: a reviewed draft from an earlier turn must survive a
      // dropped connection, and freezing this as a spec version would put a
      // one-line error notice in the viewer's version history forever.
      isError = true;
      const msg = `${describeAgentApiFailure(apiFailure)}. The spec doc was not updated, so send your request again to retry.`;
      await sendStatus(msg, turnFailure());
      summaryParts.push(msg);
    } else if (result.ccIsError) {
      // The runtime flagged the run as errored. A scout's final message IS
      // the product (the prompt says so verbatim), so text produced by an
      // errored run is the runtime's own explanation, not a spec — surface
      // it instead of storing it. Previously this branch also required an
      // EMPTY ccText, which both stored error text as specs and made the
      // `ccText || 'unknown'` below dead: it could only ever print
      // "unknown".
      isError = true;
      const providerMsg = await codexProviderFailureText(pool, req.user.id, result);
      const msg = providerMsg || `Scout error: ${(ccText || 'unknown').substring(0, 200)}`;
      await sendStatus(msg, turnFailure({
        ...executionAgentMeta,
        providerFailure: codexOpenRouter.providerFailureDiagnostics(result),
      }));
      summaryParts.push(msg);
    } else if (!ccText) {
      isError = true;
      // Markerless exits (exitCode -1, or null — never normalized) mean
      // the run died, not that the scout chose to write nothing.
      const msg = (result.exitCode === -1 || result.exitCode == null)
        ? `${describeMarkerlessExit(result.markerlessCause)} No spec text was produced.`
        : 'Scout finished but produced no spec text.';
      await sendStatus(msg, turnFailure(executionAgentMeta));
      summaryParts.push(msg);
    } else {
      const publication = await persistScoutPublication({
        pool,
        sessionId: session.id,
        turnId: durableTurnId,
        content: ccText,
        conversationContent: result.lastResultText || '',
        hadSpec: !!existingSpec,
        durationMs: Date.now() - turnStartedMs,
        localAgentLabel: runLocally ? lease.label : null,
        agentBackend: executionAgentMeta.agentBackend,
        agentModel: executionAgentMeta.agentModel,
      });
      session.spec_md = ccText;
      if (publication.applied) {
        send('status', { text: publication.scoutText, ...publication.metadata });
        send('spec_updated', {
          length: ccText.length,
          lines: publication.lineCount,
          version: publication.specVersion,
        });
      }
      summaryParts.push(
        publication.hadSpec
          ? `The scout revised the session's spec doc (now ${publication.lineCount} lines). `
            + `The user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`
          : `The scout investigated the repo and drafted a ${publication.lineCount}-line markdown spec. `
            + `It now lives in the session's spec doc; the user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`
      );
    }

    // A local scout has no costUsd at all (see dispatchLocalScout), so this
    // billing block produces no llm_usage row, spend settlement, or usage
    // event for that path.
    if (isCodexSession) {
      // Codex/OpenRouter spend is recorded on agent_turns by
      // completeCodexTurn either way. #2571: when the key is the INCLUDED
      // (company-funded) one it is also debited into the shared `llm_usage`
      // ledger, because that is the week-to-date total the one account-wide
      // cap is measured against — Claude spend and included-key spend come
      // out of the same pool. A personal key is the user's own OpenRouter
      // account and stays out of the ledger entirely, as it always has.
      if (result.costUsd) {
        const cents = Math.round(result.costUsd * 100);
        const pooled = await sharedPoolCodexSpend(pool, req.user.id, cents);
        send('usage', { costCents: cents, model: `codex-openrouter/${turnModel}`, byok: !pooled });
      }
    } else if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      // Scout costs land in the same llm_usage table as build dispatches —
      // they're real Anthropic spend on the same daily budget. #664: a
      // platform-dispatched scout may have switched to the owner's key
      // mid-turn — split the debit across both buckets accordingly.
      const split = await limits.settleTurnSpend(pool, req.user.id, ccCostCents, {
        turnByok: !!userApiKey,
        byokObservedCents: worker.getTurnByokCents(session.id),
        turnId: result.turnId || null,
        sessionId: session.id,
      });
      if (split.platformCents > 0) send('usage', { costCents: split.platformCents, model: `scout/${selectedModel}`, byok: false });
      if (split.byokCents > 0) send('usage', { costCents: split.byokCents, model: `scout/${selectedModel}`, byok: true });
    }
    durableTailComplete = true;
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    if (durableTailComplete && durableTurnId && typeof beforeTurnCleanup === 'function') {
      try {
        await beforeTurnCleanup({ turnId: durableTurnId, isError });
      } catch (err) {
        err.retainActiveTurn = true;
        throw err;
      }
    }
    if (durableTailComplete && durableTurnId && (!deferTurnCleanup || headless)) {
      await finishToolTurnCleanup(session.id, durableTurnId, { required: headless });
    } else {
      if (!durableTailComplete) {
        log.warn('sessions', 'Scout tail failed; retaining durable turn for recovery', {
          sessionId: session.id,
        });
      }
    }
    // #907: persist the execution venue after the durable worker lifecycle
    // has either completed or been retained for recovery.
    await localAgent.recordTurnRunner(
      pool, session.id, runLocally ? 'local' : 'platform', lease?.label
    );
    if (runLocally) {
      localAgent.recordTurnEvent(pool, {
        userId: session.user_id,
        appId: session.app_id,
        sessionId: session.id,
        mode: 'scout',
        outcome: isError ? 'failed' : 'completed',
        runtime: lease.runtime,
        durationMs: Date.now() - turnStartedMs,
      });
    }
    // Turn completion counts as activity: a fresh idle window so the
    // auto-pause sweeper can't pause the session moments after a long
    // scout finishes (its last_activity_at is otherwise still the user
    // message that started it).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    // No destroyWorker here — the warm container stays so the next
    // dispatch (build or another scout) can reuse it. Idle eviction
    // and session archive both own teardown.
  }

  return {
    // Scout's summary really is a tool result — the Mayor writes the
    // wrap-up from it — so the prompt bound stays. The spec itself is
    // persisted separately and in full (persistScoutPublication).
    toolResultText: summaryParts.join('\n\n').slice(0, MAYOR_TOOL_RESULT_CHAR_MAX)
      || (isError ? 'Scout did not complete successfully.' : 'Scout finished with no summary.'),
    isError,
    turnId: durableTurnId,
  };
}

// Plain-terms explanation of a markerless turn (worker exitCode -1 / null
// — the detached wrapper never wrote its __USERNODE_EXIT__ line). The
// cause tag is set by worker.js's journal consumer; the bare
// "exited with code -1" wording is deliberately gone (it read like a
// Claude Code failure when the agent was usually healthy).
// A status that describes a turn ENDING BADLY, rather than a step finishing.
//
// `turnError: true` is the only thing that tells the transcript to draw a
// failure — without it the row falls through to the generic system status,
// whose settled icon is the pipeline's green ✓ (see the `failure` row in
// features/dev-chat/transcript-store.ts). The catch-all turn error has set
// it since #894; the agent-run failures below did not, so "Scout finished but
// produced no spec text" and "Worker error: …" were reported in green.
//
// Spreads rather than mutates: `executionAgentMeta` is one object shared by
// every status the run emits, and marking it here would mark the run's
// successes too.
function turnFailure(meta) {
  return { ...(meta || {}), turnError: true };
}

function describeMarkerlessExit(cause) {
  switch (cause) {
    case 'oom_killed':
      return 'The coding agent was killed, most likely because it ran out of memory.';
    case 'container_gone':
      return "The coding agent's worker container disappeared mid-run.";
    case 'probe_unobservable':
      return "The platform lost contact with the coding agent's run.";
    case 'turn_process_gone':
      return "The coding agent's process ended without reporting a result.";
    default:
      return "The coding agent's run ended without reporting a result.";
  }
}

// One automatic retry for headless scout/build turns that died without
// producing anything: markerless exit, no __USERNODE_RESULT__ line, and
// no per-mode output (commit for build, spec text for scout — the caller
// passes that as `producedOutput`). Interactive turns stay single-shot —
// a human is present to re-dispatch — and a user-stopped turn is a
// deliberate end, not a failure to retry.

// #2118: USD to fractional cents at six decimal dollars, the precision the
// ledger's own estimate is read at, so the composer's meter and the reply
// row never disagree with agent_turns.
function codexCostCents(usd) {
  return Math.round(usd * 1e6) / 1e4;
}

// #2571: debit an OpenRouter turn against the platform's shared weekly pool
// when — and only when — it ran on the account's INCLUDED (company-funded)
// key. That key is the company's money, so its spend belongs in the same
// `llm_usage` week-to-date total limits.checkBudget measures the one
// account-wide cap against; a personal key belongs to the user and is
// metered by nobody here. Answers whether the debit happened, which is also
// what the usage event's `byok` flag reports (pooled → billed to the
// platform, not to the user's own account).
async function sharedPoolCodexSpend(pool, userId, costCents) {
  if (!userId || !(costCents > 0)) return false;
  if (!await managedOpenRouter.usesIncludedKey(pool, userId)) return false;
  await limits.recordSpend(pool, userId, costCents, { byok: false });
  return true;
}

// ── Shared per-attempt Codex dispatch (plan 7) ─────────────────────────
// Encapsulates the logical-turn + per-attempt accounting for BOTH the
// scout and build call sites so a retry cannot be merged into the prior
// attempt's ledger row (one physical Codex invocation = one attempt) and
// a retry never reuses a terminal turnUuid. `dispatchOnce(attemptNumber)`
// is provided by the caller and must itself call worker.execInWorker with
// the attempt's turnUuid/logicalTurnId/attemptNumber.
async function runCodexAttemptLoop({
  pool, session, userId, config, isCodexSession, turnModel,
  resumeThreadId, resolveRuntime, dispatchOnce, retryPredicate,
  sendStatus, waitForStopped, prepareRetry, classifyAttemptStatus,
  containerName, mode = 'build', telemetryComponent = null,
}) {
  // One logical turn id per coding-tool invocation (plan 7.1); attempt 1
  // gets attempt_number=1, a retry gets attempt_number=2.
  const logicalTurnId = crypto.randomUUID();
  const runtimeContext = await resolveRuntime();
  if (runtimeContext?.error) return { error: runtimeContext.error, logicalTurnId };
  if (!runtimeContext) return null; // Claude turn — caller handles it.

  // #2118: what the turn cost, as the ledger recorded it. completeCodexAttempt
  // already estimates each attempt from its immutable pricing snapshot
  // (agent_turns.estimated_cost_usd); this sums those over the logical turn
  // and is where the figure becomes visible: published on the session's
  // in-memory progress entry so the /status poll's `spend` carries it while
  // the session is busy (the channel Claude Code's live tracker feeds), and
  // returned so the caller can send the usage receipt and persist it on the
  // reply. Null until an attempt reports a finite estimate: an unpriced
  // model stays unknown, never a false zero.
  let estimatedCostUsd = null;
  const completeAttempt = async (attempt, result, status, err) => {
    const providerFailure = codexOpenRouter.providerFailureDiagnostics(result);
    const completion = await agentTurn.completeCodexAttempt({
      pool,
      turnUuid: attempt.turnUuid,
      status,
      threadId: result?.agentThreadId || null,
      usageTotal: agentTurn.usageTotalFromResult(result
        ? { ...result, agentHarness: runtimeContext.agentHarness }
        : result),
      usageScope: agentTurn.usageScopeForHarness(runtimeContext.agentHarness),
      telemetryComponent: result?.providerDispatched === true
        ? (telemetryComponent
          || (mode === 'scout' ? 'coding_agent_scout' : 'coding_agent_build'))
        : null,
      telemetryMetrics: result || null,
      errorCode: err
        ? agentTurn.classifyErrorCode(err)
        : result?.agentRetryFresh ? 'resume_thread_missing'
          // #2676: a classified OpenRouter refusal is a real ledger code.
          // Without this the row's error_code stayed NULL on every provider
          // failure, so errorClassByCode had nothing to read and the turn's
          // telemetry error_class fell back to a shapeless 'provider'.
          : codexLedgerErrorCode(result),
      errorDetail: providerFailure ? JSON.stringify(providerFailure)
        : err ? agentTurn.sanitizeError(err) : null,
    });
    const attemptUsd = completion?.estimatedCost?.estimatedCostUsd;
    if (typeof attemptUsd === 'number' && Number.isFinite(attemptUsd)) {
      estimatedCostUsd = (estimatedCostUsd || 0) + attemptUsd;
      workerProgress.setSpend(session.id, {
        costCents: codexCostCents(estimatedCostUsd),
        estimated: true,
      });
    }
  };

  let lastResult = null;
  let lastError = null;
  let attemptNumber = 0;
  // A thread the runtime refused to resume (it was written by the other CLI,
  // #3296) stays refused even though the caller read it off the session row.
  let attemptResumeThreadId = runtimeContext.resumeThreadDropped
    ? null
    : (resumeThreadId ?? runtimeContext.resumeThreadId ?? null);
  let allowRetryPendingForAttempt = false;
  // #2676: null means "use the runtime's own ceiling". A max_tokens refusal
  // sets it for attempt two so the retry asks for a reply the account can
  // actually pay for.
  let attemptModelMetadata = null;
  const statusFor = ({ result = null, error = null, failed = false } = {}) => {
    const fallback = failed || error ? 'failed' : 'completed';
    if (typeof classifyAttemptStatus !== 'function') return fallback;
    const classified = classifyAttemptStatus({ result, error, failed });
    return ['completed', 'failed', 'cancelled'].includes(classified)
      ? classified
      : fallback;
  };
  for (;;) {
    attemptNumber += 1;
    let attempt;
    try {
      attempt = await agentTurn.startCodexAttempt({
        pool, session, userId, logicalTurnId, attemptNumber,
        model: runtimeContext.agentModel,
        reasoningEffort: runtimeContext.agentReasoningEffort,
        resumeThreadId: attemptResumeThreadId,
        runtimeContext,
        allowRetryPending: allowRetryPendingForAttempt,
        mode,
        telemetryComponent: telemetryComponent
          || (mode === 'scout' ? 'coding_agent_scout' : 'coding_agent_build'),
      });
    } catch (startErr) {
      // plan 8.5 (Commit 6): a stale-version/busy race surfaces as a
      // structured code so the caller can tell the user the agent context
      // changed under it (no paid dispatch with stale credentials/model).
      if (startErr?.code === 'agent_context_changed') {
        return { error: 'agent_context_changed', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
      }
      if (startErr?.code === 'session_busy') {
        return { error: 'session_busy', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
      }
      return { error: 'ledger_start_failed', errorDetail: agentTurn.sanitizeError(startErr), logicalTurnId };
    }

    let dispatchResult;
    try {
      dispatchResult = await dispatchOnce({
        ...runtimeContext,
        // After the spread on purpose: a clamped retry overrides the ceiling
        // the runtime resolved for attempt one (#2676).
        ...(attemptModelMetadata ? { agentModelMetadata: attemptModelMetadata } : {}),
        // execInWorker consumes resumeSessionId; resumeThreadId is also
        // overridden so custom dispatchers never observe the stale value.
        resumeThreadId: attemptResumeThreadId,
        resumeSessionId: attemptResumeThreadId,
        turnUuid: attempt.turnUuid,
        logicalTurnId,
        attemptNumber,
        journalPath: attempt.journal,
        // A same-process missing-thread retry leaves attempt one in
        // tail_pending until startCodexAttempt atomically installs attempt
        // two's dispatch intent. Persistence stays mandatory at this boundary.
        requireActiveTurnPersistence: allowRetryPendingForAttempt,
      });
    } catch (err) {
      lastError = err;
      const observedResult = err?.turnResult || null;
      await completeAttempt(attempt, observedResult, statusFor({
        result: observedResult,
        error: err,
        failed: true,
      }), err);
      throw err;
    }

    lastResult = dispatchResult;
    lastError = null;
    const failed = !!(lastResult?.fatalError || lastResult?.ccIsError
      || (lastResult?.agentExit != null && lastResult?.agentExit !== 0)
      || (lastResult?.exitCode != null && lastResult?.exitCode !== 0));
    // Keep ledger completion outside the dispatch catch. If this required
    // write fails, retrying it with `result = null` would erase the usage we
    // just observed and falsely terminalize the attempt as an empty failure.
    await completeAttempt(attempt, lastResult, statusFor({ result: lastResult, failed }));

    // A stale resume is a runner-to-host retry request for every Codex
    // turn. Markerless headless retries remain caller-controlled. Attempt
    // 1 is ALREADY terminal before attempt 2 starts.
    const retryFresh = lastResult?.agentRetryFresh === true;
    // OpenRouter reports how many output tokens this key can cover. Retry
    // once below that allowance; the refusal does not prove account balance.
    const clampRetry = retryFresh || !failed ? null : codexMaxTokensRetry(lastResult);
    const retryRequested = retryFresh || !!clampRetry
      || (typeof retryPredicate === 'function' && retryPredicate(lastResult));
    if (!retryRequested) break;
    // Guard against spinning: exactly one retry.
    if (attemptNumber >= 2) break;
    if (typeof sendStatus === 'function') {
      const status = retryFresh
        ? 'The saved OpenRouter model context is unavailable, retrying fresh once…'
        : clampRetry
          ? 'OpenRouter rejected the reply limit. Retrying once with a smaller reply limit…'
          : 'The coding step failed unexpectedly, retrying once…';
      try { await sendStatus(status); } catch {}
    }
    if (!retryFresh && typeof waitForStopped === 'function') {
      try { await waitForStopped(session.id, containerName); } catch {}
    }
    // Retry preparation is also the last stop boundary before attempt two.
    // A callback returns false when a user stop landed during the status /
    // wait / durable-state transition; in that case do not create another
    // ledger row and, most importantly, do not launch another paid request.
    if (typeof prepareRetry === 'function') {
      const prepared = await prepareRetry({
        retryFresh,
        attempt,
        logicalTurnId,
        attemptNumber,
        result: lastResult,
      });
      if (prepared === false) break;
    }
    if (retryFresh) attemptResumeThreadId = null;
    if (clampRetry) {
      attemptModelMetadata = {
        ...(runtimeContext.agentModelMetadata || {}),
        maxOutputTokens: clampRetry.clamped,
      };
    }
    allowRetryPendingForAttempt = retryFresh;
  }
  return { result: lastResult, error: lastError, logicalTurnId, estimatedCostUsd };
}


function shouldRetryHeadlessTurn(result, stopHandle, producedOutput) {
  if (!result || producedOutput) return false;
  if (stopHandle && stopHandle.stopped) return false;
  return result.exitCode === -1 && !result.resultSeen;
}

// #1204: one automatic re-dispatch for a scout turn whose final message is
// a transport-failure notice instead of a spec. Unlike the markerless
// retry above this is NOT headless-only: the reported symptom ("often
// getting spec result of 'API Error: Connection lost mid-response'") is an
// interactive one, a scout is read-only so re-running it changes nothing,
// and the human's only alternative is to retype the same request. A
// user-stopped turn is still a deliberate end, not a failure to retry.
function shouldRetryApiErrorTurn(result, stopHandle) {
  if (!result) return false;
  if (stopHandle && stopHandle.stopped) return false;
  return !!agentApiFailure(result.lastResultText);
}

// Retry once at 80% of the reported allowance, leaving room for a changed
// prompt or balance. Respect the catalog floor and never increase the cap
// actually sent: a contradictory refusal needs diagnosis, not a larger bill.
function codexMaxTokensRetry(result, stopHandle) {
  if (!result) return null;
  if (stopHandle && stopHandle.stopped) return null;
  if (result.agentErrorCode !== 'insufficient_credits_max_tokens') return null;
  if (result.providerRequest?.limitSource === 'openrouter_in_flight_budget') return null;
  const affordable = Number(result.affordableOutputTokens);
  if (!Number.isFinite(affordable) || affordable < MIN_MAX_OUTPUT_TOKENS) return null;
  const clamped = Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(affordable * 0.8));
  const sent = result.providerRequest?.maxOutputTokens;
  if (Number.isSafeInteger(sent) && clamped >= sent) return null;
  return { clamped };
}

// #2676: both credit codes land on the ledger's own `insufficient_credits`,
// which is the code errorClassByCode bills as 'billing'.
const CODEX_LEDGER_ERROR_CODES = {
  insufficient_credits: 'insufficient_credits',
  insufficient_credits_max_tokens: 'insufficient_credits',
  rate_limited: 'rate_limited',
  credential_failure: 'credential_failure',
};
function codexLedgerErrorCode(result) {
  return CODEX_LEDGER_ERROR_CODES[result?.agentErrorCode] || null;
}

// #2676: the terminal sentence for a Codex turn that died on a provider
// refusal. The raw provider text is a paragraph of JSON the user cannot act
// on, and the branches below otherwise printed the bare word "unknown".
// Which account is paying decides the remedy, so ask; a lookup failure
// defaults to the personal-key wording, which tells the user to check their
// own key rather than blaming the platform's.
async function codexProviderFailureText(pool, userId, result) {
  if (!result?.agentErrorCode) return null;
  let includedKey = false;
  try {
    includedKey = await managedOpenRouter.usesIncludedKey(pool, userId);
  } catch { includedKey = false; }
  return codexOpenRouter.describeProviderError({
    code: result.agentErrorCode,
    requestedTokens: result.requestedOutputTokens ?? null,
    affordableTokens: result.affordableOutputTokens ?? null,
    requestDiagnostic: result.providerRequest,
    raw: result.agentError || '',
    includedKey,
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// #937: confirm a stop actually landed, instead of firing one kill and
// assuming. Runs DETACHED from the POST /stop request (the user gets their
// response immediately; this keeps working behind it).
//
// The original defect: during worker spin-up there is no turn process to
// kill — the container may not even exist — so the single in-container
// TERM/KILL walk matched nothing and exited 0, `worker.stopTurn` logged
// "Stop signal sent", and the agent then started and ran to completion.
// Probing lets us notice that the process is still (or newly) there and
// send the kill again; combined with the pending-stop record the agent
// usually never starts at all, and this is the backstop for when it does.
//
// The loop exits early when the turn unwinds on its own — the chat handler
// deletes its stop handle from the registry, so a handle mismatch means
// there is nothing left to kill.
// Shared entry point for classic sessions and agent conversations. The caller
// receives an HTTP-shaped result with common ownership, durable intent and
// confirmation. Agent conversations request immediate hard cancellation;
// classic sessions retain their existing stop/force escalation policy.
async function requestSessionStop({ pool, sessionId, user, force = false, immediate = false, expectedTurnId = null, scheduleInteractiveRecovery = null }) {
    // #1378: owner OR an admin who is allowed to WRITE. GET
    // /api/sessions/:id is admin-readable and GET .../status has no
    // ownership guard at all, so an admin could already watch someone
    // else's runaway turn — but this route was owner-only, so their stop
    // came back 404 and the client rendered "Couldn't stop the agent". An
    // admin who can see a turn burning platform capacity must be able to
    // end it.
    //
    // Deliberately `canAdminWrite` and not `isAdmin`: the latter includes
    // view-only admins, and killing someone's in-flight turn is a
    // privileged mutation (same gate middleware/admin.js uses). POST /chat
    // stays owner-only — reading and stopping are not writing on someone
    // else's behalf.
    const stopAsAdmin = user?.canAdminWrite === true;
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id FROM chat_sessions WHERE id = $1 AND (user_id = $2 OR $3::boolean)`,
        [sessionId, user.id, stopAsAdmin]
      );
      if (!rows.length) return { status: 404, body: { error: 'Session not found' } };
      if (rows[0].user_id !== user.id) {
        log.info('sessions', 'Admin stopping another user\'s turn', {
          sessionId, by: user.username, ownerId: rows[0].user_id,
        });
      }
    } catch (err) {
      log.error('sessions', 'Stop session lookup failed', { message: err.message });
      return { status: 500, body: { error: 'Internal server error' } };
    }

    // #937: In classic sessions, `{ force: true }` is offered after a
    // normal stop has visibly failed to land (its 40s rung). Strictly
    // second-order: it is only honoured once a stop is already pending for
    // this turn. The internal `immediate` option is for agent conversations;
    // the classic HTTP route does not accept it from a request body.
    const forceRequested = force === true;

    const handle = stopRegistry.get(sessionId);
    if (expectedTurnId) {
      const current = await turnLifecycle.loadActiveTurn(pool, sessionId);
      if (turnLifecycle.turnIdentity(current) !== expectedTurnId) {
        return { status: 409, body: { error: 'The running job changed. Refresh its status before stopping it.', code: 'turn_changed' } };
      }
    }
    // Keep the classic escalation policy while giving agent conversations
    // first-click hard cancellation. Neither can interrupt final wrap-up.
    const action = immediate
      ? (handle?.phase === 'mayor2' ? 'wrap_up_not_stoppable' : handle ? 'force' : 'force_orphan')
      : stopPolicy.classifyStopRequest({ handle, force: forceRequested });

    if (immediate && action !== 'wrap_up_not_stoppable') {
      const durable = await turnLifecycle.loadActiveTurn(pool, sessionId);
      if (expectedTurnId && turnLifecycle.turnIdentity(durable) !== expectedTurnId) {
        return { status: 409, body: { error: 'The running job changed. Try Stop again.', code: 'turn_changed' } };
      }
      if (durable) {
        const marked = await turnLifecycle.markStopRequested(pool, {
          sessionId, turnId: durable.turnId, journal: durable.journal, by: user.username,
        });
        if (turnLifecycle.turnIdentity(marked.activeTurn) !== turnLifecycle.turnIdentity(durable)) {
          return { status: 409, body: { error: 'The running job changed. Try Stop again.', code: 'turn_changed' } };
        }
      }
      await pool.query('UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1', [sessionId]);
    }

    if (action === 'no_active_turn') {
      const durable = await turnLifecycle.loadActiveTurn(pool, sessionId);
      if (durable && turnLifecycle.RECOVERABLE_PHASES.has(turnLifecycle.phaseOf(durable))) {
        const marked = await turnLifecycle.markStopRequested(pool, {
          sessionId, turnId: durable.turnId, journal: durable.journal, by: user.username,
        });
        if (turnLifecycle.turnIdentity(marked.activeTurn) !== turnLifecycle.turnIdentity(durable)) {
          return { status: 409, body: { error: 'The running job changed. Try Stop again.', code: 'turn_changed' } };
        }
        await pool.query('UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1', [sessionId]);
        // A different process may own the journal consumer. The durable
        // request survives its restart; signalling the worker ends the job,
        // and only its normal cleanup/recovery releases the busy record.
        await worker.stopTurn(sessionId);
        await scheduleRetainedInteractiveTurn({ pool, sessionId, scheduleInteractiveRecovery });
        return { status: 202, body: { stopped: true, stopping: true } };
      }
      // #1378: this used to return silently, which is why the production
      // report had nothing to go on — the click landed, the server said
      // "nothing to stop", and the only trace was the user watching a turn
      // keep running. Log the disagreement between what the client can see
      // (`busy`) and what this process holds (`handle`), because that gap
      // IS the bug class: a turn adopted by another process, or one whose
      // handle was cleared while the tail is still unwinding.
      let hasDurableTurn = false;
      try {
        hasDurableTurn = !!(await turnLifecycle.loadActiveTurn(pool, sessionId));
      } catch {}
      log.warn('sessions', 'Stop request had no active turn', {
        sessionId,
        busy: isSessionBusy(sessionId),
        hasDurableTurn,
        by: user.username,
      });
      return { status: 200, body: {
        ok: true, stopped: false, reason: 'no active turn', hasDurableTurn,
      } };
    }
    if (action === 'force_orphan') {
      // The turn already ended, but its bookkeeping may not have — this is
      // how a client whose turn died without unwinding gets it cleaned up.
      // #907: that bookkeeping now includes a local turn row, which is what
      // a machine that went to sleep mid-turn leaves behind.
      await localAgent.requestStop(pool, { sessionId, userId: null }).catch(() => {});
      await forceStopSession(pool, sessionId, user.username, null, { immediate, expectedTurnId });
      await scheduleRetainedInteractiveTurn({
        pool, sessionId, scheduleInteractiveRecovery,
      });
      return { status: 200, body: { ok: true, stopped: true, forced: true, phase: null } };
    }
    if (action === 'force_without_stop') {
      return { status: 409, body: {
        ok: false, stopped: false, reason: 'no stop pending',
      } };
    }
    if (action === 'wrap_up_not_stoppable') {
      // Phase-2 is non-stoppable on purpose. The UI already swaps the
      // stop button for a spinner during this phase, so this branch is
      // mostly defense against an out-of-date client.
      return { status: 200, body: { ok: true, stopped: false, reason: 'wrap-up cannot be stopped' } };
    }

    handle.stopped = true;
    handle.stoppedBy = user.username;
    // #937: stamped once, on the FIRST stop for this turn, so the client's
    // escalation ladder survives a reload (GET /status serves it) and a
    // repeat POST — the 15s retry — doesn't reset the user's clock.
    if (!handle.stopRequestedAt) handle.stopRequestedAt = Date.now();
    log.info('sessions', 'Stop requested', {
      sessionId,
      phase: handle.phase,
      by: user.username,
      ccRunning: handle.phase === 'cc',
      hasWorker: !!handle.workerName,
      forced: forceRequested,
    });

    // #889: announce the stop on every channel BEFORE any of the work
    // below. The turn's own `send` fans this out to the live POST SSE, the
    // global WS broadcast and the session bus, so every tab watching this
    // session (not just the one that clicked) flips to the "stopping…"
    // state immediately instead of waiting for the turn to unwind. It's a
    // synchronous write + broadcast, so nothing here waits on it.
    try {
      handle.send?.('stopping', {
        by: user.username,
        phase: handle.phase,
        // #937: lets a tab that joins (or reloads) mid-stop rebuild the
        // escalation ladder at the right rung instead of restarting it.
        stopRequestedAt: handle.stopRequestedAt,
      });
    } catch {}

    // #1378: the same intent, recorded durably on the turn record.
    //
    // The in-memory stamp above is the fast path and is what ends the turn
    // in every ordinary case. It cannot survive this process, though, and a
    // blue-green cutover landing in the same second as the click would take
    // it: the version that adopts the turn would resume it, narrate an
    // interruption the user had already asked for, and — on an api-error
    // tail — retry it. buildRecoveryStopHandle in server.js reads this stamp
    // at adopt time and seeds the recovered turn's handle from it, which is
    // what closes that window.
    //
    // It also leaves the only durable trace a pending stop has ever had:
    // this incident was diagnosed with no record in the log OR the database
    // that a stop had been asked for at all.
    //
    // Best-effort. The stamp is a compare-and-set against the turn identity
    // and is a quiet no-op for a legacy row with neither a turnId nor a
    // journal; none of that is a reason to refuse a stop the handle can
    // already honour, so a failure here only warns.
    try {
      const durableTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
      if (durableTurn && (durableTurn.turnId || durableTurn.journal)) {
        await turnLifecycle.markStopRequested(pool, {
          sessionId,
          turnId: durableTurn.turnId || null,
          journal: durableTurn.journal || null,
          by: user.username,
        });
      }
    } catch (err) {
      log.warn('sessions', 'Durable stop stamp failed', {
        sessionId, err: err.message,
      });
    }

    // #161: clicking stop proves presence — disarm notify_on_done BEFORE
    // aborting so the turn's resulting send('done') doesn't create a
    // spurious "your session finished" notification. This stays awaited and
    // stays ahead of the abort: the abort can unwind the Mayor stream into
    // send('done') within milliseconds, and notifySessionDone re-reads this
    // column. It is a single indexed UPDATE (~1ms) and was never where the
    // stop latency lived — see the journal-marker fix in worker.stopTurn.
    await pool.query(
      `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
      [sessionId]
    ).catch((err) => log.warn('sessions', 'stop disarm failed', { sessionId, err: err.message }));

    // #907: if this turn was handed to a machine of the user's, the thing to
    // stop is not in a container here — it is a `claude` process on their
    // laptop. Mark the turn stopped: awaitTurnResult unblocks immediately
    // (so the tail below unwinds at the same speed as a container kill), and
    // the CLI learns about it on its next progress POST, which now 409s.
    // The confirm loop below is skipped for these: it probes a worker
    // container this turn never had, so every probe would report "idle" and
    // the log line would claim a kill it never sent.
    if (handle.localTurnId) {
      await localAgent.requestStop(pool, { sessionId, userId: null })
        .catch((err) => log.warn('sessions', 'Local agent stop failed', {
          sessionId, err: err.message,
        }));
    }

    if (!handle.localTurnId && stopPolicy.killsWorkerInPhase(handle.phase)) {
      // Detached-turn path: the CC turn runs as a detached exec with no
      // host-side child to signal, so kill run-cc.sh + claude inside
      // the container directly. The warm wrapper (sleep infinity)
      // survives, keeping the next dispatch fast. stopTurn also appends
      // the journal's exit marker (#889), so the consumer resolves right
      // away and runClaudeCodeTool's early-return branch fires in ~1s
      // rather than on the liveness watchdog's 10s cadence.
      //
      // #937: this CONFIRMS rather than assumes. One fire-and-forget kill
      // was the original defect — during spin-up there was nothing to
      // kill, yet the log still said "Stop signal sent". See
      // confirmStopLanded; see killsWorkerInPhase for why 'mayor1' counts.
      //
      // At most ONE loop per turn. Repeat stops for the same turn are
      // expected — the client re-POSTs once at its 15s rung, and a force
      // arrives as a second request — and each starting its own loop would
      // multiply the bounded kill-attempt budget by the number of clicks.
      // The force path does its own, more aggressive teardown regardless.
      if (!handle.confirming && action !== 'force') {
        handle.confirming = true;
        confirmStopLanded(sessionId, handle)
          .catch((err) => log.warn('sessions', 'stop confirm loop failed', { sessionId, err: err.message }))
          // Cleared on settle, so a stop re-requested AFTER a loop gave up
          // gets a fresh attempt budget rather than being silently ignored.
          .finally(() => { handle.confirming = false; });
      }
    } else if (handle.workerName) {
      // Legacy single-shot fallback: stop the whole worker through its
      // runtime. Kubernetes removes the Deployment and retains the workspace;
      // Docker keeps the existing stop-only behavior.
      worker.stopWorker(handle.workerName)
        .catch((err) => log.warn('sessions', 'Worker stop failed', { err: err.message }));
    }

    try { handle.abort.abort(); } catch {}

    if (action === 'force') {
      // Immediately terminate the process tree when requested; evict only
      // if the kill cannot be confirmed. Settle even if the owner is wedged.
      await forceStopSession(pool, sessionId, user.username, handle, { immediate, expectedTurnId });
      await scheduleRetainedInteractiveTurn({
        pool, sessionId, scheduleInteractiveRecovery,
      });
      return { status: 200, body: { ok: true, stopped: true, forced: true, phase: handle.phase } };
    }

    return { status: 200, body: { ok: true, stopped: true, phase: handle.phase } };
}

async function confirmStopLanded(sessionId, handle) {
  const startedMs = Date.now();
  const containerName = handle?.workerName || worker.workerContainerName(sessionId);
  let attempts = 0;

  const sendKill = async () => {
    attempts += 1;
    await worker.stopTurn(sessionId).catch(
      (err) => log.warn('sessions', 'stopTurn failed', { sessionId, attempts, err: err.message })
    );
  };

  await sendKill();

  for (;;) {
    await sleepMs(stopPolicy.STOP_PROBE_INTERVAL_MS);
    if (stopRegistry.get(sessionId) !== handle) {
      log.info('sessions', 'Stop confirmed (turn unwound)', {
        sessionId, attempts, elapsedMs: Date.now() - startedMs,
      });
      return 'confirmed';
    }
    const executing = await worker.isWorkerExecuting(containerName);
    const verdict = stopPolicy.classifyStopProbe({
      executing, attempts, elapsedMs: Date.now() - startedMs,
    });
    if (verdict === 'confirmed') {
      log.info('sessions', 'Stop confirmed (worker idle)', {
        sessionId, attempts, elapsedMs: Date.now() - startedMs,
      });
      return verdict;
    }
    if (verdict === 'giveup') {
      // The one line that makes the next incident of this class
      // diagnosable from the platform log alone. Force stop is the user's
      // remaining path, and their UI is already offering it by now.
      log.warn('sessions', 'Stop NOT confirmed — worker still executing', {
        sessionId, containerName, attempts, executing,
        elapsedMs: Date.now() - startedMs,
      });
      return verdict;
    }
    log.info('sessions', 'Stop unconfirmed — re-issuing kill', {
      sessionId, containerName, attempts, executing,
    });
    await sendKill();
  }
}

// Hard cancellation for agent conversations, and the existing classic
// force-stop escape hatch. Kill the turn in place first, preserving the warm
// worker. If that fails, evict it while retaining the workspace; only that
// fallback incurs a cold start on the next dispatch.
//
// We announce the stop ourselves rather than waiting for the owning
// request to do it: that request may be the wedged thing we're rescuing
// the user from. The duplicate `stopped`/`done` it emits afterwards is
// harmless — the client's stopping-state helpers are idempotent.
async function forceStopSession(pool, sessionId, username, handle, { immediate = false, expectedTurnId = null } = {}) {
  const containerName = handle?.workerName || worker.workerContainerName(sessionId);

  // #1378: the force-orphan path arrives here with `handle === null` (a turn
  // adopted after a restart never had one, and a handle that already cleared
  // is the same story), and every announcement below used to be
  // `handle?.send?.(...)` — a silent no-op precisely when the user most needs
  // to be told the turn is over. Fall back to the two channels a live turn's
  // own `send` fans out over, with the `_seq` sessionBus.publish requires.
  const announce = handle?.send || (() => {
    const { broadcastGlobal } = require('../services/ws');
    const seqPrefix = `force-${sessionId}-${Date.now().toString(36)}`;
    let seq = 0;
    return (type, data) => {
      const event = { type, _seq: `${seqPrefix}-${++seq}`, ...(data || {}) };
      // Spread first, pin the envelope last — same reason as the live send:
      // an inner `type` must not clobber `type: 'session_event'`.
      try { broadcastGlobal({ ...event, sessionId, event: type, type: 'session_event' }); } catch {}
      try { sessionBus.publish(sessionId, event); } catch {}
    };
  })();

  // The ordinary stop may be a beat from landing; don't destroy a
  // container that is already going quietly.
  let executing;
  if (immediate) {
    // No initial probe, TERM grace period, retry timer or second button.
    // The worker confirms its process tree is gone in the same command.
    const killed = await worker.stopTurn(sessionId, { force: true }).catch(() => false);
    // A root-only idle probe cannot rule out a surviving tool child after
    // an incomplete tree kill. Without confirmation, evict the whole worker.
    executing = killed ? false : null;
  } else {
    executing = await worker.isWorkerExecuting(containerName);
    if (executing !== false) {
      await worker.stopTurn(sessionId).catch(() => {});
      await sleepMs(stopPolicy.STOP_PROBE_INTERVAL_MS);
      executing = await worker.isWorkerExecuting(containerName);
    }
  }
  if (executing !== false) {
    if (expectedTurnId && turnLifecycle.turnIdentity(await turnLifecycle.loadActiveTurn(pool, sessionId)) !== expectedTurnId) {
      throw Object.assign(new Error('The running job changed. Retry Stop.'), { code: 'turn_changed' });
    }
    await worker.evictWorker(sessionId).catch(
      (err) => log.warn('sessions', 'force stop evict failed', { sessionId, err: err.message })
    );
    // Give the owning journal consumer a short chance to terminalize with
    // any usage it already observed. The fallback below is for the wedged
    // owner this force path exists to rescue.
    await sleepMs(250);
    executing = await worker.isWorkerExecuting(containerName);
    if (executing !== false) {
      const error = new Error('Could not confirm that the coding job stopped. Retry Stop.');
      error.code = 'stop_unconfirmed';
      throw error;
    }
  }
  try {
    const activeTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    if (activeTurn && expectedTurnId && turnLifecycle.turnIdentity(activeTurn) !== expectedTurnId) {
      throw Object.assign(new Error('The running job changed. Retry Stop.'), { code: 'turn_changed' });
    }
    if (activeTurn) {
      let ledgerReady = true;
      if (activeTurn.backend === 'codex_openrouter' && activeTurn.turnUuid) {
        let attempt = await agentTurn.getCodexAttemptRecoveryState({
          pool,
          turnUuid: activeTurn.turnUuid,
        });
        if (attempt?.status === 'running') {
          await sleepMs(250);
          attempt = await agentTurn.getCodexAttemptRecoveryState({
            pool,
            turnUuid: activeTurn.turnUuid,
          });
        }
        if (attempt?.status === 'running' || !attempt) {
          try {
            await agentTurn.completeCodexAttempt({
              pool,
              turnUuid: activeTurn.turnUuid,
              status: 'cancelled',
              errorCode: 'user_cancelled',
              errorDetail: 'Turn was force-stopped by the user.',
              telemetryComponent: turnLifecycle.phaseOf(activeTurn) === turnLifecycle.PHASE_DISPATCH_PENDING
                ? null
                : activeTurn.telemetryComponent || null,
              telemetryMetrics: {
                requestMode: activeTurn.telemetryRequestMode || null,
                requestMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
                requestUserMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
                requestContentBlockCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
                requestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
                requestUserTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
                requestPayloadCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
                modelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
                modelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
              },
            });
          } catch (ledgerErr) {
            ledgerReady = false;
            const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
              pool,
              sessionId,
              activeTurn,
              error: ledgerErr,
            });
            log.warn('sessions', disposition.action === 'retry'
              ? 'Force stop retained durable turn because ledger cancellation failed'
              : 'Force stop quarantined a turn with a missing ledger attempt', {
              sessionId, turnUuid: activeTurn.turnUuid, err: ledgerErr.message,
            });
          }
        }
      }
      if (ledgerReady) {
        await worker.clearActiveTurn(sessionId, turnLifecycle.cleanupArgs(activeTurn));
      }
    }
  } catch (err) {
    if (err.code === 'turn_changed') throw err;
    log.warn('sessions', 'Force stop could not clear the owned durable turn', {
      sessionId, err: err.message,
    });
  }
  activeWorkers.delete(sessionId);

  const byStr = username ? ` by @${username}` : '';
  const text = `Stopped${byStr} (forced).`;
  log.warn('sessions', 'Turn force-stopped', {
    sessionId, containerName, by: username, evicted: executing !== false,
  });

  try {
    announce('status', { text, quickReplies: turnFallbackQuickReplies({ outcome: 'stopped' }) });
  } catch {}
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [sessionId, text, JSON.stringify({ quickReplies: turnFallbackQuickReplies({ outcome: 'stopped' }) })]
  ).catch(() => {});

  try {
    announce('stopped', { phase: handle?.phase || null, by: username, forced: true });
    announce('done', {});
  } catch {}

  stopRegistry.deleteIf(sessionId, handle);
}

// Pre-retry safety: kill any zombie turn process and wait (bounded) for
// the container to probe idle, so the re-dispatch can't race two claudes
// in one container (the new wrapper's `rm -f turn-*.log` only runs once
// the old turn is confirmed dead). Returns whether idle was confirmed;
// the caller retries either way — worst case the dispatch itself fails.
async function waitForTurnStopped(sessionId, containerName, { timeoutMs = 30000 } = {}) {
  try { await worker.stopTurn(sessionId); } catch {}
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await worker.isWorkerExecuting(containerName);
    if (busy === false) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Runs the full Claude Code pipeline for one tool invocation and returns
// a compact summary suitable for feeding back to the Mayor as a
// `tool_result`. All user-visible side effects (status events, progress
// log message, staging deploy, PR creation, vote reset, PR comment) are
// kept exactly as they were in the prior non-tool-use flow — this
// function is a mechanical extraction of that block, not a behavior
// change, except that it now returns a summary string instead of
// emitting a final [CODING AGENT COMPLETED] status at the end of the
// turn (we still emit that status, but ALSO return the text).
// Tailored remediation per staging-failure class. The `fix` text ends up
// in the Mayor's tool_result and on the user's screen, so it has to be
// self-contained: the Mayor doesn't read code, and the user shouldn't
// have to either. Keep prose short but concrete enough that
// "dispatch_claude_code" + this message is sufficient to drive an
// automated fix on the next turn. Shared by the interactive tail (where
// the failure is fatal to the turn) and the headless tail (#183, where
// it's non-fatal — the pushed commit is the deliverable).
// Turn a failure to warm the worker container into a `tool_result` the
// Mayor can act on, instead of letting it escape to the chat handler's
// generic catch.
//
// Same reasoning as the staging-failure catch further down: without this
// the Mayor never finds out anything went wrong, the user sees a bare
// "Chat error" toast, and the next turn has no idea the dispatch never
// happened. The difference from a staging failure is what it can promise —
// nothing ran, so the branch is exactly as it was.
async function workerBootstrapFailureResult(err, {
  session, send, sendStatus, statusMeta = {}, durableTurnId = null,
}) {
  const friendly = describeTurnError(err);
  log.error('sessions', 'Worker bootstrap failed', {
    sessionId: session.id,
    message: err && err.message,
    phase: (err && err.bootstrapPhase) || null,
    attempts: (err && err.bootstrapAttempts) || null,
    containerName: (err && err.bootstrapContainerName) || null,
    bootstrapLog: Array.isArray(err && err.bootstrapLog) ? err.bootstrapLog.join('\n') : null,
  });
  await sendStatus(friendly, statusMeta);
  activeWorkers.delete(session.id);
  workerProgress.clear(session.id);
  if (typeof send === 'function') send('error', { error: friendly });
  return {
    toolResultText:
      `The coding agent could not be started, so this dispatch never ran and the branch is unchanged.\n\n${friendly}`,
    isError: true,
    turnId: durableTurnId,
  };
}

function describeStagingFailure(stagingErr) {
  let fix;
  let missingKeys = [];
  if (stagingErr instanceof staging.PrivateSecretMissingStagingDefaultError) {
    missingKeys = stagingErr.missingKeys || [];
    fix =
      `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a secret' : 'secrets'} ` +
      `[${missingKeys.join(', ')}] as \`required\` + \`private\` (or the legacy alias \`sensitive: true\`), ` +
      `but with no \`staging_default\` (or \`default\`). Private secrets are intentionally NOT ` +
      `propagated from prod into staging clones, so without a manifest fallback the staging ` +
      `build refuses to start. ` +
      `\n\nFix: add \`"staging_default": "<value>"\` to each ${missingKeys.length === 1 ? 'entry' : 'entry'} in \`dapp.json\`. ` +
      `If the app's code degrades gracefully when the secret is unset, use the empty string \`""\`. ` +
      `For paid services use a vendor sandbox key (e.g. Stripe \`sk_test_...\`). ` +
      `Never copy the prod value into \`staging_default\`. ` +
      `See \`app-conventions.md\` "Public vs private secrets" for the full rubric. ` +
      `\n\nThe agent can apply this fix directly: dispatch \`dispatch_claude_code\` with a prompt ` +
      `like "edit dapp.json so each of [${missingKeys.join(', ')}] has staging_default set to <chosen value>".`;
  } else if (stagingErr instanceof staging.MissingSecretsError) {
    missingKeys = stagingErr.missingSecrets || [];
    fix =
      `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a required secret' : 'required secrets'} ` +
      `[${missingKeys.join(', ')}] that ${missingKeys.length === 1 ? 'has' : 'have'} no stored value in this ` +
      `app's secret store, and no \`default\` in the manifest. ` +
      `\n\nFix: an admin needs to set ${missingKeys.length === 1 ? 'this value' : 'these values'} in the platform UI ` +
      `(Settings → Secrets) before staging can build. The agent CANNOT fix this from code — ` +
      `secret values are intentionally not committed to source. ` +
      `If a manifest \`default\` is appropriate (i.e. the value is genuinely public), the agent can ` +
      `instead add it to \`dapp.json\` via \`dispatch_claude_code\`.`;
  } else {
    fix =
      `Underlying error: ${(stagingErr && stagingErr.message) || String(stagingErr)}. ` +
      `This is most likely an infrastructure or build-time failure (Docker build, network, ` +
      `image cache, etc.) rather than a manifest issue. The agent can suggest the user retry, ` +
      `inspect platform logs, or — if the build error message implicates the dapp's own code — ` +
      `dispatch \`dispatch_claude_code\` to investigate.`;
  }

  // Defensive: if buildAndDeployStaging ever returned null/undefined
  // without throwing (it shouldn't — its contract is throw-or-return-
  // result), stagingErr would be null here. Coerce so callers still emit
  // a meaningful event instead of NPE'ing.
  const errMsg = (stagingErr && stagingErr.message) || 'Unknown staging failure (no error thrown but no result returned)';
  const errName = (stagingErr && stagingErr.name) || 'Error';
  return { fix, missingKeys, errMsg, errName };
}

// Local Claude and Codex/OpenRouter do not have hosted Claude's independently
// verified appended-system-prompt transport. Keep their existing browser and
// testing guidance inline, byte-for-byte, so this optimization cannot change
// those backends. Hosted Claude receives a compact pointer because every build
// invocation is already required to carry the complete platform handbook as
// system context.
const INLINE_CODING_AGENT_TESTING_GUIDANCE = `- End your FINAL message with a testing block (optional, but strongly
  encouraged whenever the change is user-visible) so reviewers can try the
  change in the staging preview:

==== TESTING ====
path: /relative/path?demo=1
path: /another/changed/view
1. First step a tester should take.
2. What they should see if the change works.
==== END TESTING ====

  Rules for the testing block:
  - The "path:" line points the before/after screenshots (and the "Test
    this change" button) at the route where the change is visible. Each
    must be a RELATIVE path within the app (starts with "/", no scheme or
    host).
  - For user-visible changes, include at least one "path:" line pointing
    at the SPECIFIC screen where the change is VISIBLE, unless the same
    commit adds a named visual scenario to its dapp.json check. Explicit
    paths are the most precise choice and also drive "Test this change".
    Without either one, Homeroom falls back to the home page and records that
    default so a wrong screenshot can be reported. Use "path: /" only when
    the change genuinely renders there as the page loads.
  - The screenshots and the button can only NAVIGATE — they never click,
    play, or fill anything in. If no URL reaches the changed screen
    (in-game state, a modal/sheet, a wizard step), ADD one: a
    screenshot-state deep link — a query/hash param the app handles at
    boot to enter that state deterministically (e.g.
    "/?shot=settlement-sheet" starts a demo match on a fixed seed and
    opens the settlement panel) — per "Make the changed screen URL-reachable"
    in the supplied platform conventions. Point "path:" at it, add a
    dapp.json test asserting it renders, and verify it in the in-loop
    browser before committing. A "path: /" screenshot of an
    interaction-gated change is as good as no testing block.
  - Every "path:" is captured in BOTH frames automatically: the desktop
    viewport (1280x800, still + animated recording) and a phone-sized
    viewport (390x844, still image only). Mobile-only changes are
    therefore covered without any annotation — just point "path:" at the
    right route. The legacy "@mobile" annotation is still accepted but
    is redundant now; never rely on the desktop frame alone for a
    narrow-screen change.
  - You may give MORE THAN ONE "path:" line (one per line, up to 3,
    captured in the order written) when the change spans several views —
    e.g. a new nav item plus the page it opens. Each becomes its own
    labelled before/after row. The FIRST path is also the deep link the
    "Test this change" button jumps to.
  - SELF-APP (social-vibecoding) ONLY: this app is a hash-routed SPA — its
    internal screens live in the URL fragment ("#app/<slug>/dev/...",
    "#leaderboard"), NOT in the server pathname. Write the "path:" using
    the in-app route segments exactly as they appear after the "#"
    (e.g. "path: /app/<self-slug>/dev/proposals/<id>" or
    "path: /leaderboard") — the platform moves it into the fragment when
    capturing screenshots and when the "Test this change" button opens the
    preview, so the shot lands on the changed screen instead of the home
    feed. Standalone server pages ("/dashboard", "/admin", "/status",
    "/node-status") stay as plain pathnames. (This only applies to the
    self-app; ordinary apps are path-routed and need no special handling.)
  - The steps are short markdown (numbered list preferred), written for a
    non-technical tester looking at a staging preview seeded with a copy of
    production data.
  - DATA AVAILABILITY: before writing the steps, check what each step's
    data actually looks like in staging — existing public tables carry a
    copy of production data, but tables created by THIS change and
    staging:private tables are EMPTY. If a step needs data that won't
    exist, you MUST seed it in this same commit per the "Staging mock
    data" convention above (IS_STAGING boot-time seed, or a
    staging-gated ?demo=1 route — always a no-op in production), and
    write the steps against the seeded entities by name ("Open the
    thread 'Staging demo thread' and …"). Point "path:" at a view where
    the seeded data is visible (or at the ?demo=1 route). Changes
    testable purely against production-cloned data need no seeding.
  - The block must be the LAST thing in your final message. Skip the block
    entirely for changes with nothing user-visible to test.`;

const HOSTED_CLAUDE_TESTING_GUIDANCE = `- End your FINAL message with a testing block (optional, but strongly
  encouraged whenever the change is user-visible) so reviewers can try the
  change in the staging preview:

==== TESTING ====
path: /relative/path?demo=1
path: /another/changed/view
1. First step a tester should take.
2. What they should see if the change works.
==== END TESTING ====

  The authoritative system instructions contain the complete testing-path,
  screenshot-state, self-app routing, mobile capture, staging-data, and seed
  rules. Follow them. For this output block:
  - Include one to three relative "path:" lines for the specific screen where
    a user-visible change can be seen. The FIRST path drives the "Test this
    change" button.
  - Keep the steps short, numbered when practical, and understandable to a
    non-technical tester.
  - The block must be LAST in your final message. Skip it entirely for changes
    with nothing user-visible to test.`;

// OpenRouter sessions never pay for a model call to write their proposal text
// (pr-metadata.js deterministicPrMetadataDraft), so the description the group
// votes on is whatever the coding agent writes here (#2820). Parsed by
// services/proposal-description.js; each turn's block replaces the last.
const OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE = `- Whenever you changed and committed files this turn, end your FINAL
  message with a proposal description block. It becomes the description
  people read before voting on this change:

==== DESCRIPTION ====
One or two short paragraphs, in plain language, describing what the WHOLE
change on this branch does for someone using the app.
==== END DESCRIPTION ====

  Rules for the description block:
  - Describe the ENTIRE change so far, including earlier turns on this
    branch, not just this turn. It REPLACES the previous description, so
    anything you leave out disappears from the proposal.
  - Write it for the people voting on the change: what is different, what
    they can now do, or what stops going wrong. Do not narrate your work
    ("Done", "I updated…"), list files, quote commit hashes, or report
    check results; that belongs in the rest of your message.
  - Put it after the rest of your message and BEFORE the testing block,
    which stays last. Skip it when you changed no files.`;

function buildHostedCodingWorkflowGuidance({ runLocally = false } = {}) {
  if (runLocally) return '';
  return `HOSTED WORKER LIFECYCLE (this invocation):
- You are already inside Homeroom's hosted coding worker for this session.
  Repository instructions for an external, locally running proposal agent,
  including .agents/skills/usernode-proposal, do not apply here. Do not run
  that skill, the social-vibecoding CLI, device login, or external proposal
  submission tools from this worker.
- For a committed change, call the provided declare_visible_changes MCP
  tool with concrete reviewer-facing claims and real user flows (or impact
  "none" with a specific reason for a non-visual change). If the tool fails,
  report the failure; never claim that intent was recorded when it was not.
- Implement the change, run focused checks, commit it on the existing session
  branch, and finish the turn. The Homeroom harness handles push, pull request
  creation, staging, checks, and scheduling the paired shots run after
  your commit. Do not perform those lifecycle steps yourself.
- The in-loop browser is optional. If the supplied local runtime or app auth
  cannot be brought up promptly, say the visual check was skipped and commit
  the change. Do not create platform users or tokens, or copy production data
  just to make the local browser check pass.`;
}

function buildCodingAgentBuildGuidance({ authoritativeSystemContext = false } = {}) {
  if (!authoritativeSystemContext) {
    return {
      browserGuidance: IN_LOOP_BROWSER_GUIDANCE,
      testingGuidance: INLINE_CODING_AGENT_TESTING_GUIDANCE,
    };
  }
  return {
    browserGuidance: HOSTED_CLAUDE_IN_LOOP_BROWSER_GUIDANCE,
    testingGuidance: HOSTED_CLAUDE_TESTING_GUIDANCE,
  };
}

// Hosted Claude build turns carry the platform handbook as appended system
// context instead of repeating its full ~130 KB inside every user message.
// Claude Code keeps system context outside conversation history and reloads it
// after compaction, so resumed sessions retain one authoritative copy without
// accumulating another copy per dispatch. Local Claude and Codex/OpenRouter
// keep the legacy inline block until their transports have an equivalent,
// independently verified system-context path.
//
// #2817: the UI design guidance (src/prompts/design-guidance.md) travels
// the same way, right after the conventions, so every backend builds with
// the same design brief and a hosted Claude session carries one copy of it
// rather than another per dispatch.
//
// Pure and exported for deterministic transport tests.
function buildCodingAgentConventionsContext({
  runLocally = false,
  isCodexSession = false,
  conventions = getAppConventions(),
  designGuidance = '',
} = {}) {
  const designBlock = designGuidance ? `\n\n${designGuidance}` : '';
  const fullBlock = `==== PLATFORM CONVENTIONS (authoritative) ====

${conventions}

==== END PLATFORM CONVENTIONS ====${designBlock}`;

  if (runLocally || isCodexSession) {
    return { promptBlock: fullBlock, systemPrompt: null };
  }

  return {
    promptBlock: `==== PLATFORM CONVENTIONS (authoritative) ====

The complete platform conventions are supplied separately as authoritative
system instructions for this invocation. They override conflicting personal
or repository guidance on platform-wide rules.${designGuidance ? ' The UI design guidance is supplied\nwith them.' : ''}

==== END PLATFORM CONVENTIONS ====`,
    systemPrompt: fullBlock,
  };
}

// Build the two user-level spec representations a hosted Claude build may
// need. The full block is the behavior every backend had before this helper.
// The resumed block is safe only when canReuseHostedClaudeScoutSpec proves
// that the exact current spec is already the immediately preceding response
// in the same hosted Claude conversation. Keeping both as ordinary prompt
// content avoids elevating user/repository text into system instructions.
function buildCodingAgentSpecContext({ currentSpec = '', specTaskReference = '' } = {}) {
  const spec = String(currentSpec || '');
  if (!spec.trim()) return { fullBlock: '', resumedBlock: '' };

  const fullBlock = `

==== SPEC DOC (planning context, authoritative for what to build) ====

${spec}

==== END SPEC DOC ====

The SPEC DOC above is the user's planning record for this session,
refined collaboratively with the Mayor. Treat it as the authoritative
description of WHAT to build and HOW IT SHOULD BEHAVE. ${specTaskReference}
tells you which request to handle in this turn — it is NOT a substitute
for the spec, and you should
not re-derive intent from it when the spec covers the same ground.
Platform conventions still override the spec on any platform-wide
rule (auth, public/private tables, etc.).`;

  const resumedBlock = `

==== SPEC DOC (planning context, authoritative for what to build) ====

The immediately preceding assistant response in this resumed hosted-Claude
conversation is the exact current SPEC DOC saved by the platform. Continue
from that already-loaded spec; do not re-derive it or ask for another copy.

==== END SPEC DOC ====

That existing SPEC DOC is the user's planning record for this session,
refined collaboratively with the Mayor. Treat it as the authoritative
description of WHAT to build and HOW IT SHOULD BEHAVE. ${specTaskReference}
tells you which request to handle in this turn — it is NOT a substitute
for the spec. Platform conventions still override the spec on any
platform-wide rule (auth, public/private tables, etc.).`;

  return { fullBlock, resumedBlock };
}

// Reuse the scout response only at a deliberately narrow, provable boundary:
// the latest coding-agent activity is a completed hosted-Claude scout whose
// stored output exactly equals the live spec. A later build/scout progress row,
// a local/Codex scout, a changed spec, or legacy metadata all fail closed.
// The query returns only the boolean comparison; it never selects prompt text.
async function canReuseHostedClaudeScoutSpec(pool, sessionId, currentSpec) {
  const spec = String(currentSpec || '');
  if (!pool || typeof pool.query !== 'function' || !sessionId || !spec.trim()) return false;
  const { rows } = await pool.query(
    `SELECT (
       metadata ? 'scoutOutput'
       AND metadata->>'agentBackend' = 'claude_code'
       AND NOT (metadata ? 'runner')
       AND metadata->>'scoutConversationSpecExact' = 'true'
       AND metadata->>'scoutOutput' = $2
     ) AS reusable
       FROM chat_session_messages
      WHERE session_id = $1
        AND (metadata ? 'scoutOutput' OR content = 'Claude Code progress')
      ORDER BY id DESC
      LIMIT 1`,
    [sessionId, spec],
  );
  return rows[0]?.reusable === true;
}

async function runClaudeCodeTool({
  pool, config, req, res, session, selectedModel,
  userMessage, toolPromptArg,
  // #450: current-turn user attachments block — see runScoutTool.
  attachmentsBlock = '',
  // #945: issue / proposal Discussion threads — see runScoutTool.
  discussionBlock = '',
  repoOwner, repoName,
  send, sendStatus,
  stopHandle,
  userApiKey,
  // #155/#183: headless auto sessions may commit + push their branch and
  // deliberately build a staging preview, but must NOT open a PR — that
  // happens later, lazily, when a dev chat cloned off the auto session is
  // proposed to the group. Swaps the success-path tail for the headless
  // variant (staging, no PR); everything else (worker exec, push
  // accounting, cost debit) is identical.
  headless = false,
  // OpenRouter sessions have no separate chat model or Mayor. Their selected
  // model receives the user's turn directly and may answer without changing
  // files; a clean no-change result is therefore a successful chat reply,
  // not a failed coding dispatch.
  directSessionTurn = false,
  deferTurnCleanup = false,
  beforeTurnCleanup = null,
}) {
  activeWorkers.add(session.id);
  // #50: wall-clock start for the durationMs persisted on terminal
  // statuses, so the dev-chat "(took Xm Ys)" suffix survives reloads.
  const turnStartedMs = Date.now();
  // Name the exact coding-agent model in the spin-up status and reuse that
  // same provider-neutral identity for progress, transcript, and usage. Codex
  // sessions use the pinned OpenRouter model and NO Anthropic key.
  const agentIdentity = codingAgentRuntimeIdentity(session, selectedModel, config);
  const {
    isCodex: isCodexSession,
    model: turnModel,
    modelLabel,
  } = agentIdentity;
  const turnApiKey = isCodexSession ? null : (userApiKey || null);
  // May switch to the user's local Claude runtime once the lease lookup below
  // completes. The early stop gate still truthfully names the session-pinned
  // cloud agent, because no execution venue has been chosen at that point.
  let executionAgentName = agentIdentity.agentName;
  let executionAgentMeta = agentIdentity.metadata;
  let durableTurnId = null;
  // #2118: the turn's ledger estimate (USD), summed by runCodexAttemptLoop
  // over its attempts; null for a Claude turn or an unpriced model. Function
  // scope on purpose: the return below reads it outside the dispatch block.
  let codexEstimatedCostUsd = null;

  // #937: the single way this tool ends on a stop — used by all five
  // pre-dispatch gates below AND by the post-run branch, so wording,
  // pills and duration can't drift between them.
  //
  // It does its own teardown because the gates fire on both sides of the
  // big `try` further down: the ones before it (spin-up, ensureWorker,
  // syncUserAgentFiles) would otherwise skip that try's `finally`. Every
  // step is idempotent, so a gate INSIDE the try double-running it via the
  // finally is a no-op.
  //
  // `result` is passed only from the post-run branch, where the agent may
  // have got further than the user realises. In the incident that prompted
  // this fix the run had ALREADY committed the whole change when it was
  // killed, and the chat said only "Claude Code stopped" — so the user had
  // to ask "Is the work done?" and pay for a second agent run to find out.
  // We still open no PR and build no preview; we just stop hiding what
  // landed on the branch.
  const stoppedResult = async (result = null) => {
    const byStr = stopHandle?.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
    const commits = result && result.sha && result.ahead > 0 ? result.ahead : 0;
    const shortSha = commits ? String(result.sha).slice(0, 8) : null;
    // #1378: shared with the recovered-turn stop path — see
    // describeStoppedLanding. `?? 0` keeps an absent `ahead` reading as
    // "nothing landed", which is what this call site has always done.
    const landed = describeStoppedLanding({
      sha: result?.sha || null,
      ahead: result?.ahead ?? 0,
      pushOk: result?.pushOk === true,
    });
    // #894: no phase-2 wrap-up follows a stop, so this status row is the
    // turn's only pill carrier.
    // #1378's `landed` clause is the SENTENCE; `stopped` is the same facts
    // as data, so the transcript can render them as chips instead of asking
    // the client to parse its own prose back out. The sentence stays: it is
    // what a shared transcript, a notification and a plain-text export show.
    await sendStatus(`${executionAgentName} stopped${byStr}${landed}.`, {
      ...executionAgentMeta,
      durationMs: Date.now() - turnStartedMs,
      stopLanding: stopLandingMeta({
        headline: `${executionAgentName} stopped${byStr}`,
        sha: result?.sha || null,
        ahead: result?.ahead ?? 0,
        pushOk: result?.pushOk === true,
      }),
      quickReplies: turnFallbackQuickReplies({ outcome: 'stopped' }),
    });
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    // NOT worker.finishTurn: releasing the held turn record stays the
    // exclusive job of the `finally` below (tests/turn-tail-lifecycle
    // pins that). A gate that fires before the dispatch never held one in
    // the first place, and a gate inside the try reaches that finally.
    return {
      toolResultText: `${executionAgentName} was stopped${byStr} before it finished.${
        commits
          ? ` It had already committed ${commits} change${commits === 1 ? '' : 's'} (${shortSha})`
            + `${result.pushOk ? ' and pushed the branch' : ' but the branch was not pushed'},`
            + ' and no PR was opened.'
          : ' No commit was pushed.'
      }`,
      isError: true,
      ccLog: result ? ((result.rawStderr || '').substring(0, 5000) || null) : null,
      stagingUrl: null,
      turnId: durableTurnId,
    };
  };

  // #937 gate 1 of 5 — entry. A stop that landed while the Mayor was still
  // deciding (or in the awaited gap between the end of its stream and
  // `setPhase('cc')` — spend recording, the busy-worker guard, a GitHub PR
  // round trip) must not buy the user a whole build.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // #616: read-only prod-debug access for admin-owned sessions on the
  // self-edit app. Checked fresh per turn; the internal prod-debug
  // routes re-check per request, so this flag only controls env + prompt
  // injection. Failure means no access — never a failed turn.
  let prodDebug = false;
  try {
    prodDebug = await debugAccess.isEligible(pool, session.id);
  } catch (err) {
    log.warn('sessions', 'Prod-debug eligibility check failed (continuing without)', {
      sessionId: session.id, err: err.message,
    });
  }
  // #907: is a coding agent on the user's own machine holding this session?
  //
  // Never for headless turns: those run unattended, on a schedule, with
  // nobody watching — offering them to a laptop that may be shut, asleep, or
  // simply not running the CLI would turn a reliable background build into a
  // 90-second offer timeout. Headless always uses a worker container.
  //
  // A lookup failure means "no local agent", never a failed turn.
  let lease = null;
  if (!headless && !isCodexSession) {
    try {
      lease = await localAgent.activeLease(pool, session.id);
    } catch (err) {
      log.warn('sessions', 'Local agent lease lookup failed (using worker)', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  const runLocally = !!lease;
  if (runLocally) {
    executionAgentName = 'Claude Code';
    executionAgentMeta = { agentBackend: 'claude_code', agentModel: null };
  }
  await sendStatus(
    runLocally
      ? `Handing this turn to ${lease.label}: your machine, your Claude subscription${discussionBlock ? ' · with issue & proposal discussion' : ''}...`
      : (isCodexSession
        ? `Starting OpenRouter (${modelLabel}${discussionBlock ? ' · with issue & proposal discussion' : ''})...`
        : `Spinning up coding agent (${modelLabel}${prodDebug ? ' · prod debug' : ''}${discussionBlock ? ' · with issue & proposal discussion' : ''})...`),
    runLocally
      ? {
          ...executionAgentMeta,
          runner: 'local', localAgentLabel: lease.label, localMode: 'build',
        }
      : executionAgentMeta
  );

  // A local run needs no worker image, no warm container and no volume: the
  // checkout, the model call and the tests all happen on the user's machine.
  if (!runLocally) await worker.ensureWorkerImage();

  // #937 gate 2 of 5 — after the image pull. This is where the reported
  // stop landed: 1.2s after the "Spinning up coding agent…" row.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // Platform conventions are injected fresh every turn, so updates to
  // src/prompts/app-conventions.md reach existing apps without touching
  // their repos. App-specific CLAUDE.md files (if present) are read by
  // Claude Code from the repo directly and take precedence for
  // app-specific matters only — the "authoritative" platform rules
  // below override any conflicting instruction in CLAUDE.md.
  //
  // The session's live spec doc (chat_sessions.spec_md) is also
  // injected when non-empty. The Mayor and the user have likely been
  // refining it over multiple turns; without it, CC would only see the
  // Mayor's compressed 1-4 sentence prompt arg and re-derive intent
  // from scratch. The platform-conventions block still overrides if
  // anything in the spec contradicts a platform-wide rule.
  const currentSpec = await loadSessionSpec(pool, session.id);

  // Failing proposal checks from the LAST staging run ride into this
  // turn's prompt so the agent stops flying blind on its own merge gate
  // (see buildFailingChecksBlock). Fails open: any load error just means
  // no block this turn.
  let failingChecksBlock = '';
  try {
    const { checkState, testResults } = await loadSessionCheckContext(pool, session.id);
    failingChecksBlock = buildFailingChecksBlock(checkState, testResults);
  } catch (err) {
    log.warn('sessions', 'Failing-checks context load failed (continuing without)', { sessionId: session.id, err: err.message });
  }
  const specTaskReference = directSessionTurn
    ? 'The DIRECT USER TURN above'
    : 'The "CODING TASK (from the Mayor)" line above';
  const specContext = buildCodingAgentSpecContext({ currentSpec, specTaskReference });
  let reuseHostedScoutSpec = false;
  if (!runLocally && !isCodexSession && session.cc_session_id && currentSpec.trim()) {
    try {
      reuseHostedScoutSpec = await canReuseHostedClaudeScoutSpec(
        pool,
        session.id,
        currentSpec,
      );
    } catch (err) {
      // Optimization only: uncertainty keeps the complete spec in this turn.
      log.warn('sessions', 'Scout-to-build context check failed (using full spec)', {
        sessionId: session.id,
        err: err.message,
      });
    }
  }

  // #460: the dispatching user's personal agent files. Loaded here (by
  // session OWNER — headless sessions with no resolvable owner simply
  // get none) and materialized into the warm worker's CC volume right
  // after ensureWorker below. The prompt note is only added when files
  // exist so everyone else's prompt stays byte-identical. Failures are
  // non-fatal: the build proceeds without personal files.
  //
  // Skipped entirely for a local run (#907): the user's personal agent files
  // already live at ~/.claude on the machine about to run this turn. Pushing
  // the platform's stored copy at it would be both pointless and rude — that
  // is their filesystem, not ours.
  let personalFiles = [];
  try {
    if (session.user_id && !runLocally) {
      personalFiles = await userAgentFiles.loadAllForUser(pool, session.user_id);
    }
  } catch (err) {
    log.warn('sessions', 'Personal agent files load failed (continuing without)', { sessionId: session.id, err: err.message });
  }
  const personalFilesNote = personalFiles.length
    ? `

PERSONAL AGENT FILES: the user who dispatched this run has personal
instruction files (already loaded for you at \`~/.claude/CLAUDE.md\`)
and/or personal skills (under \`~/.claude/skills/\`). Treat them as the
dispatching user's personal preferences: follow them wherever they don't
conflict with the platform conventions supplied to this run (which always win)
or the repo's own \`CLAUDE.md\` on app-specific matters.`
    : '';
  const platformIssueHelperNote = isCodexSession
    ? 'The `usernode-report-platform-issue` helper is NOT available on this backend; do not call it.'
    : `A build-turn helper \`usernode-report-platform-issue\` is also available (run it via Bash): \`usernode-report-platform-issue "<short title>"\` with the issue detail on stdin. Use it for anything that needs a change OUTSIDE this app's repo — both platform-level breakage (the shared bridge, wallet / native mobile WebView, the staging/preview pipeline, the checks gate) AND missing platform capabilities the app needs (feature requests: a bridge API that doesn't exist, data the platform doesn't expose, a limit blocking a legitimate feature) — see "Platform-level problems & missing capabilities: escalate, don't file workarounds" in the supplied platform conventions. It does NOT file anything directly: it posts a draft report card into the dev chat that the user must tap to confirm (or dismiss) before an issue is filed on the platform repo. It de-dupes against open reports and earlier drafts. The one hard rule: never use it for something you can fix in this app itself.`;
  const taskBlock = directSessionTurn
    ? `DIRECT USER TURN:\n${userMessage}${attachmentsBlock}${discussionBlock}`
    : `USER REQUEST: "${userMessage}"\n\nCODING TASK (from the Mayor):\n${toolPromptArg}${attachmentsBlock}${discussionBlock}`;
  const turnInstructions = directSessionTurn
    ? (headless
      ? `- Work on the issue autonomously. If it is actionable, implement it fully and commit the change.
- If essential information is missing, make no speculative edits; explain the blocker or ask the smallest necessary question in your final response.
- Do not claim that files changed unless you actually changed and committed them.`
      : `- You are the session's selected OpenRouter model and are replying directly to the user; there is no separate chat model.
- If the user asks for information, analysis, status, or an explanation, answer directly and do not change files.
- If the user asks for a change, implement it fully and commit it. Do not stop after merely describing what should change.
- If essential clarification is required, ask one concise question and make no speculative edits.
- Never claim that files changed unless you actually changed and committed them.`)
    : `- IMPLEMENT the requested changes fully. Do not just explore — write code.
- Spend minimal time reading files. Focus on writing and editing.
- Create or modify all necessary files to complete the request.
- If building something new, implement the full feature — don't stop partway.
- After all changes are made, stage everything with "git add -A" and commit
  with a clear message describing what was built.
- Do NOT ask questions or request clarification. Just build it.`;
  const conventionsContext = buildCodingAgentConventionsContext({
    runLocally,
    isCodexSession,
    // #2817: the same design guidance for every backend. Only its self-check
    // differs: OpenRouter models read text, Claude reads screenshots.
    designGuidance: getDesignGuidance({ readsImages: !isCodexSession }),
  });
  const buildGuidance = buildCodingAgentBuildGuidance({
    authoritativeSystemContext: Boolean(conventionsContext.systemPrompt),
  });
  const workflowGuidance = buildHostedCodingWorkflowGuidance({ runLocally });
  const renderClaudePrompt = (renderedSpecBlock) => `${taskBlock}

${conventionsContext.promptBlock}
${renderedSpecBlock}${failingChecksBlock}

A \`CLAUDE.md\` at the repo root, if present, contains **app-specific**
guidance: product intent, domain terms, opt-in policies, style. Follow
it for app-specific matters. On any platform-wide rule (auth,
public/private tables, USERNODE_ENV, do-not-push, etc.) the platform
conventions supplied to this run are authoritative and override
CLAUDE.md if they conflict.

The repo's \`CLAUDE.md\` may reference a hosted copy of the platform
conventions at \`https://${process.env.USERNODE_DOMAIN || 'apps.example.invalid'}/claude.md\` —
in dev-chat those rules are already supplied by the harness, so ignore
that instruction here. It's for humans or coding-agent invocations that
run against this repo outside the harness.${personalFilesNote}

A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`); long bodies are clipped with a "[truncated …]" marker, and \`usernode-issues <number>\` fetches that one issue with its FULL body plus BOTH of its discussion surfaces (\`{ issue, comments, commentsTruncated, usernodeThread?, usernodeThreadTruncated?, note? }\` — \`comments\` are the GitHub comments, \`usernodeThread\` is the issue's Discussion thread on the platform, where people often answer clarifying questions). Consult it if an open issue is relevant to what you're building; do not try to reach GitHub any other way. ${SCREENSHOT_FETCH_NOTE}

${platformIssueHelperNote}
${runLocally ? '' : `\n${HOMEROOM_READ_NOTE}\n`}${prodDebug && !isCodexSession ? `
${debugAccess.promptBlock()}
` : ''}
INSTRUCTIONS:
${workflowGuidance}
${turnInstructions}
${buildGuidance.browserGuidance}
${isCodexSession ? `${OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE}\n` : ''}${buildGuidance.testingGuidance}`;

  const fullClaudePrompt = renderClaudePrompt(specContext.fullBlock);
  const claudePrompt = reuseHostedScoutSpec
    ? renderClaudePrompt(specContext.resumedBlock)
    : fullClaudePrompt;
  // run-cc.sh reads this only after --resume fails. A fresh session therefore
  // gets the exact complete task it received before this optimization.
  const claudeResumeFallbackPrompt = reuseHostedScoutSpec ? fullClaudePrompt : null;

  const commitMsg = github.safeMention(`Changes: ${userMessage.substring(0, 50)}`);

  // BYOK (#30): when the user has their own Anthropic key on file we
  // pass it down so the worker can hit api.anthropic.com directly.
  // When they don't, we pass null and worker.execInWorker routes the
  // SDK through the platform's Anthropic proxy (the platform key never
  // enters the worker container — see ANTHROPIC_BASE_URL/JWT in
  // src/services/worker.js and src/routes/anthropic-proxy.js).
  // execInWorker re-asserts these per-exec, so a key flip mid-session
  // takes effect on the next turn without needing a re-warm.
  //
  // #907: no container at all for a local run. The platform holds no model
  // credential for it either — the user's own `claude` login on their own
  // machine does the work, so neither their BYOK key nor the platform's proxy
  // JWT is created, sent, or needed on this path.
  await ensureBranchForDispatch(pool, session);
  let containerName = null;
  if (!runLocally) {
    try {
      containerName = await worker.ensureWorker(session.id, {
        repoOwner,
        repoName,
        branchName: session.branch_name,
        onProgress: (text) => {
          send('cc_progress', { text, ...agentIdentity.metadata });
          workerProgress.set(session.id, text, {
            model: turnModel,
            backend: agentIdentity.backend,
          });
        },
      });
    } catch (err) {
      // Same seam as the staging-failure catch below: the dispatch never
      // happened, so report that as a tool_result rather than letting the
      // throw surface as an anonymous "Chat error".
      return await workerBootstrapFailureResult(err, {
        session,
        send,
        sendStatus,
        statusMeta: {
          ...executionAgentMeta,
          durationMs: Date.now() - turnStartedMs,
        },
        durableTurnId,
      });
    }
  }

  // Surface the container name for diagnostics + admin tooling. The
  // actual stop signal flows through worker.stopTurn (in-container
  // pkill) so the warm container is preserved across stop — eviction is
  // the only path that destroys it.
  if (stopHandle) stopHandle.workerName = containerName;

  // #937 gate 3 of 5 — after ensureWorker. This is the WIDEST window: a
  // cold session clones + checks out the repo here, which can take tens of
  // seconds, and it sits entirely between "Spinning up coding agent…" and
  // "Claude Code is running…".
  if (stopPendingFor(stopHandle)) return stoppedResult();

  // #460: wipe-and-rewrite the personal agent files in the CC volume
  // every dispatch — runs even when the list is empty so a deletion in
  // Settings takes effect on the very next turn. Never fails the build.
  try {
    if (!runLocally) await worker.syncUserAgentFiles(session.id, personalFiles);
  } catch (err) {
    log.warn('sessions', 'Personal agent files sync failed (continuing without)', { sessionId: session.id, err: err.message });
  }

  // #937 gate 4 of 5 — after the personal-files sync.
  if (stopPendingFor(stopHandle)) return stoppedResult();

  let ccLog = null;
  let stagingUrl = null;
  // Hoisted to function scope so the post-finally return can expose
  // commitHash to callers (currently used to drive PR-card metadata in
  // the timeline; previously also fed the now-removed /build-spec
  // backfill of chat_session_specs.commit_sha).
  let commitHash = null;
  // Accumulates a human-readable summary of what happened that we feed
  // back to the Mayor as tool_result content. Populated in the same
  // branches that emit status events so the two stay in sync.
  const summaryParts = [];
  let isError = false;
  let durableTailComplete = true;

  try {
    // #937 gate 5 of 5 — immediately before the dispatch. Placed ahead of
    // the "Claude Code is running…" status AND the progress-row INSERT so
    // a stopped-at-spin-up turn leaves neither a status claiming the agent
    // ran (the exact lie in the bug report: that row landed 4.9s AFTER the
    // stop) nor an empty progress card in the transcript.
    if (stopPendingFor(stopHandle)) return stoppedResult();

    await sendStatus(`${executionAgentName} is running...`, executionAgentMeta);

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 5000);

    const { rows: progRows } = await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
      [session.id, JSON.stringify({ progressLog: [], ...executionAgentMeta })]
    );
    const progressMsgId = progRows[0].id;

    // Experimental AI progress estimate: while the per-user toggle is ON,
    // a 60s base ticker asks Haiku to skim the progress-log tail and emits
    // a vague "AI guess" via send('cc_estimate'). Gated hard: never for
    // headless turns (no live watcher), never without an LLM client, and
    // the whole block is skipped when the toggle is off — degradation to
    // today's behavior is structural, not a runtime branch. Estimates are
    // ephemeral (in-memory + SSE only, never persisted).
    //
    // Reliability for long runs (#323): the estimator no longer dies
    // permanently after a few failures or a flat emit count. Transient
    // Haiku errors trigger a short tick-skip backoff that resets on the
    // next success, and the cadence widens with elapsed time instead of
    // stopping — so a 12+ minute run keeps getting refreshed guesses. The
    // first guess fires even before any progress line lands, and the
    // remaining-time countdown is re-asked on a wall-clock cadence so it
    // never freezes during a long quiet phase (one slow command/edit).
    //
    // Terminal-state teardown (#891): the estimator MUST stop the moment
    // the coding run reaches a terminal phase marker, not when the whole
    // turn (PR + staging + Mayor wrap-up) is done. See stopEstimator below.
    const estimatorEnabled = !headless && !!req?.user?.aiProgressEstimate
      && (llm.isEnabled() || !!userApiKey);
    const liveProgressLines = [];
    // Most recent `[phase]` marker seen on this run's progress stream
    // (#892). Two consumers: the estimator prompt (a [commit]/[push] marker
    // means seconds remain, which is the single strongest late signal in the
    // dataset — median 1s remaining once [push] lands), and the
    // completion-claim gate (a "nearly done" phrase is only truthful once
    // the run has actually reached commit/push/done).
    let lastPhase = null;
    let estimator = null;
    // Set by stopEstimator; read by the interval body AND by the in-flight
    // call's .then so a Haiku response that lands after teardown can't
    // re-emit a guess (or INSERT an accuracy row the backfill already
    // ran past, which would strand it with actual_total_ms IS NULL).
    let estimatorDone = false;
    // Idempotent teardown for the experimental estimator (#891). Every
    // exit path funnels through here so there is exactly one place that
    // knows how to make the guess go away:
    //   - clear the interval (no further ticks),
    //   - drop the in-memory estimate so GET /api/sessions/:id/status
    //     stops serving it to the 3s poll for the rest of the turn,
    //   - emit a cleared cc_estimate so live clients blank the span
    //     immediately instead of waiting for the next full re-render.
    const stopEstimator = (reason) => {
      if (estimatorDone) return;
      estimatorDone = true;
      if (estimator) {
        clearInterval(estimator);
        estimator = null;
      }
      if (!estimatorEnabled) return;
      workerProgress.clearEstimate(session.id);
      send('cc_estimate', { text: null, remainingSeconds: null, cleared: true });
      log.info('chat', 'AI progress estimator stopped', { sessionId: session.id, reason });
    };
    // Diagnose the silent-disable case: toggle ON + live turn but no LLM
    // key path means the user sees nothing with no obvious reason (#323).
    if (!headless && !!req?.user?.aiProgressEstimate && !estimatorEnabled) {
      log.warn('chat', 'AI progress estimate skipped: no LLM key available', {
        sessionId: session.id, userId: req.user.id,
      });
    }
    if (estimatorEnabled) {
      log.info('chat', 'AI progress estimator started', { sessionId: session.id });
      let estimateInFlight = false;
      let linesAtLastEstimate = 0;
      let consecutiveFailures = 0;   // drives the backoff window
      let ticksToSkip = 0;           // remaining backoff ticks to wait out
      let estimateSuccesses = 0;     // counted only for the runaway backstop
      let lastEstimateAtMs = null;   // wall-clock of the last successful emit
      let ceilingLogged = false;
      // Monotonicity-guard state (#892). `projectedFinishAt` is the finish
      // time currently being displayed; the guard holds it steady between
      // refreshes and only moves it later for a stated cause. It always
      // yields a positive number of seconds — there is no overrun state.
      let projectedFinishAt = null;
      let previousRemainingSeconds = null;
      let phaseAtLastEstimate = null;
      // Runaway backstop only — with the widening cadence below this is
      // reached around the ~2h mark, never by a normal long run.
      const MAX_ESTIMATES = 60;
      // After this much elapsed time the cadence widens (cost containment
      // on genuinely long runs); below it we stay at the 60s base tick.
      const WIDEN_AFTER_MS = 15 * 60_000;
      const WIDE_SPACING_MS = 150_000;   // ~2.5 min minimum spacing late in a run
      const IDLE_REFRESH_MS = 180_000;   // re-ask even with no new lines so ~X left moves
      const CC_ACTION_RE = /^(Reading |Writing |Editing |\$ |Using )/;
      estimator = setInterval(async () => {
        // Torn down (terminal marker / turn end / stop) — never tick again.
        if (estimatorDone) return;
        // One call in flight at a time.
        if (estimateInFlight) return;
        // Runaway backstop: stop for good only on a pathological multi-hour
        // run. Logged once so it's diagnosable, then the timer is torn down.
        if (estimateSuccesses >= MAX_ESTIMATES) {
          if (!ceilingLogged) {
            ceilingLogged = true;
            log.info('chat', 'AI progress estimator hit emit ceiling', {
              sessionId: session.id, estimates: estimateSuccesses,
            });
          }
          stopEstimator('emit_ceiling');
          return;
        }
        // Backoff after failures: wait out the skip window, then retry. The
        // counter resets on the next success so a transient blip can't
        // disable estimates for the rest of a long run.
        if (ticksToSkip > 0) { ticksToSkip--; return; }

        const now = Date.now();
        const elapsedMs = now - turnStartedMs;
        const hasNewLines = liveProgressLines.length !== linesAtLastEstimate;
        const sinceLastMs = lastEstimateAtMs == null ? Infinity : now - lastEstimateAtMs;
        const minSpacingMs = elapsedMs >= WIDEN_AFTER_MS ? WIDE_SPACING_MS : 0;

        // #892: the displayed projection has run out while the run keeps
        // going. The guard floors the readout at 30s so it never sticks at
        // zero, but that floor is only honest for as long as it takes to get
        // a fresh guess — so an expired projection overrides the widened
        // late-run spacing (which would otherwise hold the floor for 2.5
        // minutes). Still subject to estimateInFlight, the failure backoff
        // and MAX_ESTIMATES, all checked above.
        const projectionExpired = projectedFinishAt != null && now >= projectedFinishAt;

        // Decide whether to run this tick:
        //  - first estimate ever: always (even with zero lines — the prompt
        //    renders "(no output yet)" and answers "still early …");
        //  - projection expired: always, ignoring the widened spacing;
        //  - too soon under the widened late-run cadence: skip;
        //  - new progress since last estimate: run;
        //  - otherwise idle-refresh once enough wall-clock passed so the
        //    remaining-time guess doesn't freeze during a quiet phase.
        let shouldRun;
        if (lastEstimateAtMs == null) shouldRun = true;
        else if (projectionExpired) shouldRun = true;
        else if (sinceLastMs < minSpacingMs) shouldRun = false;
        else if (hasNewLines) shouldRun = true;
        else shouldRun = sinceLastMs >= IDLE_REFRESH_MS;
        if (!shouldRun) return;

        estimateInFlight = true;
        // A long coding run can cross the user's or platform's allowance
        // between progress ticks. Re-resolve the payer for every estimate
        // so this auxiliary Haiku call cannot continue spending platform
        // credits after the main run has switched to BYOK (or stopped).
        let estimateBilling;
        try {
          estimateBilling = await limits.resolveBillingPath(
            pool,
            config.dataEncryptionKey,
            req.user.id
          );
        } catch (err) {
          estimateInFlight = false;
          log.warn('chat', 'AI progress estimator budget check failed', {
            sessionId: session.id, err: err.message,
          });
          stopEstimator('budget_check_failed');
          return;
        }
        if (estimateBilling.error) {
          estimateInFlight = false;
          stopEstimator('budget_exhausted');
          return;
        }
        if (estimatorDone || (stopHandle && stopHandle.stopped)) {
          estimateInFlight = false;
          return;
        }
        const linesAtStart = liveProgressLines.length;
        const phaseAtStart = lastPhase;
        // Distinct files the run has touched so far — one of the two new
        // prompt inputs. Derived from the same lines the caller already
        // accumulates, so it costs nothing.
        const distinctFiles = new Set(
          liveProgressLines
            .filter((l) => /^(Reading|Writing|Editing) /.test(String(l)))
            .map((l) => String(l).split(' ')[1])
        ).size;
        llm.estimateRunProgress({
          userRequest: userMessage,
          progressTail: liveProgressLines,
          elapsedMs,
          steps: liveProgressLines.filter((l) => CC_ACTION_RE.test(l)).length,
          apiKey: estimateBilling.apiKey || undefined,
          lastPhase: phaseAtStart,
          distinctFiles,
          previousGuess: previousRemainingSeconds == null ? null : {
            remainingSeconds: previousRemainingSeconds,
            elapsedMs: lastEstimateAtMs == null ? 0 : lastEstimateAtMs - turnStartedMs,
          },
          telemetryContext: {
            pool,
            appId: session.app_id,
            sessionId: session.id,
          },
        }).then(async ({ text, remainingSeconds, usage, model: estModel, promptVersion }) => {
          consecutiveFailures = 0;
          ticksToSkip = 0;
          estimateSuccesses++;
          linesAtLastEstimate = linesAtStart;
          lastEstimateAtMs = Date.now();
          const elapsedAtEstimate = lastEstimateAtMs - turnStartedMs;
          // A call resolving after the user hit stop — or after the coding
          // run reached its terminal marker (#891) — is dropped entirely:
          // no emit (the run is over, so the guess would land on the
          // wrap-up), no in-memory stash (the /status poll would re-serve
          // it for minutes), and no accuracy row (the backfill UPDATE has
          // already run, so the row would be stranded unresolved forever).
          // The spend debit below still happens: those tokens were spent.
          if (!estimatorDone && !(stopHandle && stopHandle.stopped)) {
            // #892 monotonicity guard. Chooses between the held projection
            // and this guess, and floors the result at 30s so the countdown
            // ALWAYS shows a positive time — no overrun flag, no bail-out.
            // It never scales or blends: `remainingSeconds` below stays the
            // raw model value all the way into the accuracy dataset.
            const guard = estimateGuard.applyMonotonicityGuard({
              projectedFinishAt,
              previousRemainingSeconds,
              remainingSeconds,
              estimatedAt: lastEstimateAtMs,
              now: lastEstimateAtMs,
              newPhaseSinceLast: phaseAtStart !== phaseAtLastEstimate,
            });
            projectedFinishAt = guard.projectedFinishAt;
            previousRemainingSeconds = remainingSeconds == null
              ? previousRemainingSeconds : remainingSeconds;
            phaseAtLastEstimate = phaseAtStart;

            // Completion-claim gate. "Nearly done" is only shown once the
            // run has genuinely reached commit/push/done — measured, that
            // phrase family fired with 5+ minutes still to run a third of
            // the time. Suppression rewrites the PHRASE only; the countdown
            // number is untouched, and the raw model text is still what
            // lands in estimate_text.
            const phaseHead = String(phaseAtStart || '').split(/[\s(]/)[0];
            const claimEarned = ['commit', 'push', 'done', 'push_failed'].includes(phaseHead);
            const suppressed = llm.isCompletionClaim(text) && !claimEarned;
            // Fall back to the neutral stage label — the deterministic thing
            // the platform actually knows. With no phase seen yet there is
            // nothing honest to say, so the phrase is dropped entirely.
            const shownText = suppressed
              ? (NEUTRAL_PHASE_TEXT[phaseHead] || (phaseAtStart ? 'still working' : ''))
              : text;

            send('cc_estimate', {
              text: shownText, remainingSeconds, elapsedMs: elapsedAtEstimate,
              estimatedAt: lastEstimateAtMs,
              displayedRemainingSeconds: guard.displayedRemainingSeconds,
              slipReason: guard.slipReason,
            });
            workerProgress.setEstimate(session.id, {
              text: shownText, remainingSeconds, estimatedAt: lastEstimateAtMs,
              displayedRemainingSeconds: guard.displayedRemainingSeconds,
              slipReason: guard.slipReason,
            });
            // Persist this tick to the accuracy dataset (#50 follow-up).
            // Fire-and-forget: persistence must never fail or block a turn,
            // matching the progressLog UPDATE posture below. The turn's
            // actual outcome is backfilled at the terminal choke point.
            pool.query(
              `INSERT INTO progress_estimates
                 (session_id, progress_message_id, user_id, model,
                  elapsed_ms, step_count, progress_lines,
                  estimate_text, predicted_remaining_seconds,
                  prompt_version, displayed_remaining_seconds,
                  clamped, slip_reason, estimate_text_shown, suppressed,
                  last_phase, distinct_files)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                       $10, $11, $12, $13, $14, $15, $16, $17)`,
              [
                session.id, progressMsgId, req.user.id, estModel,
                elapsedAtEstimate,
                liveProgressLines.filter((l) => CC_ACTION_RE.test(l)).length,
                liveProgressLines.length,
                // RAW model output — never the suppressed or guarded value.
                text, remainingSeconds,
                promptVersion || llm.PROMPT_VERSION,
                guard.displayedRemainingSeconds,
                guard.clamped, guard.slipReason,
                shownText || null, suppressed,
                phaseAtStart ? String(phaseAtStart).slice(0, 24) : null,
                distinctFiles,
              ]
            ).catch(() => {});
          }
          if (usage) {
            const cents = llm.estimateCostCents(usage, estModel);
            await limits.recordSpend(pool, req.user.id, cents, {
              byok: estimateBilling.byok,
            });
          }
        }).catch((err) => {
          // Self-healing backoff: skip up to 5 ticks (~5 min) after repeated
          // failures, but never stop for good — the next success resets it.
          consecutiveFailures++;
          ticksToSkip = Math.min(consecutiveFailures, 5);
          log.warn('chat', 'AI progress estimate failed; backing off', {
            sessionId: session.id, err: err.message,
            consecutiveFailures, ticksToSkip,
          });
        }).finally(() => {
          estimateInFlight = false;
        });
      }, 60_000);
    }

    // One progress sink for both runners (#907). A local run's lines arrive
    // over HTTP instead of over a container journal, but everything
    // downstream of "a line happened" — the live SSE tab, the persisted
    // progress log, the phase marker, the estimator — must not be able to
    // tell the difference.
    const onAgentProgress = (text) => {
      send('cc_progress', { text, ...executionAgentMeta });
      workerProgress.set(session.id, text, {
        model: executionAgentMeta.agentModel,
        backend: executionAgentMeta.agentBackend,
      });
      {
        const phaseMatch = String(text).trim().match(/^\[([^\]]+)\]$/);
        if (phaseMatch) lastPhase = phaseMatch[1];
      }
      if (estimatorEnabled) {
        liveProgressLines.push(text);
        if (turnWatchdog.TERMINAL_PROGRESS_LINES.includes(String(text).trim())) {
          stopEstimator('terminal_marker');
        }
      }
      pool.query(
        `UPDATE chat_session_messages SET metadata = jsonb_set(
          metadata, '{progressLog}',
          (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
        ) WHERE id = $2`,
        [JSON.stringify([text]), progressMsgId]
      ).catch(() => {});
    };

    // #907: offer the turn to the attached machine and wait for its verdict,
    // then shape the answer like an execInWorker result so the entire tail
    // below — push heal, PR metadata, checks, staging, visuals, the
    // completion card, the Mayor wrap-up — runs byte-identically. The one
    // structural difference is `pushOk: true`: a local agent has no push
    // access by design, so its commits reached the branch through the
    // platform's own GitHub App (POST /api/cli/agent/turns/:id/commit) and
    // there is nothing left to push.
    let seenLocalLines = 0;
    const localBuildCorrelationId = crypto.randomUUID();
    let localBuildAttemptNumber = 0;
    const dispatchLocalBuild = async () => {
      const baseSha = session.checks_commit_sha || null;
      const queued = await localAgent.enqueueTurn(pool, {
        sessionId: session.id,
        userId: session.user_id,
        prompt: claudePrompt,
        baseSha,
        branchName: session.branch_name,
        // Explicit even though it is the column default: this is the one turn
        // kind allowed to upload a commit, and saying so at the call site is
        // what makes the scout path's `mode: 'scout'` legible as the contrast.
        mode: 'build',
      });
      // The lease lapsed in the moment between the routing decision above
      // and here (the laptop closed mid-sentence). Nothing was dispatched, so
      // report it as the disconnect it is rather than dereferencing null.
      if (!queued) {
        return {
          sha: null,
          ahead: 0,
          behind: session.behind_main || 0,
          pushOk: true,
          exitCode: 1,
          ccIsError: true,
          fatalError: `${lease.label} disconnected before this turn started`,
          lastResultText: '',
          rawStderr: '',
          sessionId: null,
          initSessionId: null,
          markerlessCause: null,
          localTurnId: null,
          localOutcome: 'abandoned',
        };
      }
      const turnId = queued.turn.id;
      const telemetryStartedAt = new Date();
      localBuildAttemptNumber += 1;
      if (stopHandle) stopHandle.localTurnId = String(turnId);
      let announcedAccepted = false;
      const { outcome, turn: finished } = await localAgent.awaitTurnResult(pool, turnId, {
        onProgress: (row) => {
          if (!announcedAccepted && row.status !== 'queued' && row.status !== 'offered') {
            announcedAccepted = true;
            onAgentProgress(`[${lease.label} accepted the turn]`);
          }
          const lines = Array.isArray(row.progress) ? row.progress : [];
          for (const line of lines.slice(seenLocalLines)) onAgentProgress(line);
          seenLocalLines = Math.max(seenLocalLines, lines.length);
        },
      });
      recordLocalCodingInvocation(pool, {
        session,
        turnId,
        turn: finished,
        outcome,
        component: headless ? 'coding_agent_headless' : 'coding_agent_build',
        attemptNumber: localBuildAttemptNumber,
        correlationId: localBuildCorrelationId,
        startedAt: telemetryStartedAt,
      });
      const headSha = finished?.head_sha || null;
      // 'declined' and 'abandoned' are the two outcomes that are nobody's
      // fault: the checkout was dirty / on the wrong commit, or the laptop
      // went away mid-turn. Both are reported as an honest error rather than
      // as a silent no-op, because the user is sitting in front of the
      // machine that just refused and can act on the reason.
      //
      // The full set awaitTurnResult can return is completed / failed /
      // declined / stopped / abandoned / missing / aborted. 'completed' needs
      // no explanation and 'failed' already carries the runtime's own words
      // in error_detail, so both are left to the shared tail.
      const explain = {
        declined: `${lease.label} declined this turn`,
        abandoned: `${lease.label} disconnected before finishing this turn`,
        stopped: 'Stopped',
        missing: 'The local turn record disappeared',
        aborted: `${lease.label} was interrupted`,
      }[outcome] || null;
      const detail = finished?.error_detail ? `: ${finished.error_detail}` : '';
      return {
        sha: headSha,
        ahead: headSha ? 1 : 0,
        // Nothing local was fetched, so the platform's existing count is the
        // best answer; do not let a local turn reset it to zero.
        behind: session.behind_main || 0,
        pushOk: true,
        exitCode: outcome === 'completed' ? 0 : 1,
        ccIsError: outcome !== 'completed',
        fatalError: explain ? `${explain}${detail}` : null,
        lastResultText: finished?.summary || '',
        rawStderr: finished?.error_detail || '',
        sessionId: null,
        initSessionId: null,
        markerlessCause: null,
        localTurnId: String(turnId),
        localOutcome: outcome,
      };
    };

    let result;
    let codexCtx = null;
    durableTailComplete = false;
    try {
      const resumeThreadId = isCodexSession ? (session.agent_thread_id || null) : (session.cc_session_id || null);
      // Shared dispatcher for BOTH the Codex attempt loop and the Claude
      // fallback, so the expensive execInWorker options (holdTurnRecord +
      // the estimator/phase onProgress closure) live in exactly one place.
      const claudeTelemetryCorrelationId = crypto.randomUUID();
      let claudeTelemetryAttemptNumber = 0;
      const doBuild = (ctx) => {
        const isClaudeDispatch = !ctx || !ctx.logicalTurnId;
        if (isClaudeDispatch) claudeTelemetryAttemptNumber += 1;
        return worker.execInWorker(session.id, {
          mode: 'build',
          prompt: claudePrompt,
          // Present only for the first hosted-Claude build after an exact
          // matching scout. If --resume is unavailable, the runner retries
          // fresh with this complete spec-bearing user prompt.
          resumeFallbackPrompt: isClaudeDispatch ? claudeResumeFallbackPrompt : null,
          // Hosted Claude gets the same authoritative handbook on every
          // invocation as stable system context. New, resumed, compacted and
          // resume-fallback-fresh runs therefore all use the current version
          // without adding another copy to conversation history. Codex and
          // local Claude retain the inline block above.
          systemPrompt: isClaudeDispatch ? conventionsContext.systemPrompt : null,
          model: turnModel,
          commitMsg,
          resumeSessionId: resumeThreadId,
          branchName: session.branch_name,
          ...(ctx || {}),
          prodDebug,
          telemetryComponent: headless ? 'coding_agent_headless' : 'coding_agent_build',
          telemetryCorrelationId: isClaudeDispatch ? claudeTelemetryCorrelationId : null,
          telemetryAttemptNumber: isClaudeDispatch ? claudeTelemetryAttemptNumber : null,
          // Hold the durable turn record through the tail below (push heal →
          // PR → staging build → visuals → completion card → Mayor wrap-up).
          // That stretch is minutes long — a self-app staging build alone
          // spends ~4:45 cloning the platform DB — and used to run with
          // active_turn already cleared, so a restart inside it left the chat
          // frozen on "Building staging preview..." with no way back (session
          // 2954). Released by finishTurn in the finally at the end of this
          // function; every tail step stamps its milestone so a resumed tail
          // redoes none of them.
          holdTurnRecord: true,
          // #892 (phase marker), #891 (terminal-marker estimator teardown) and
          // the persisted progress log all live in onAgentProgress above, which
          // the local runner shares.
          onProgress: onAgentProgress,
        });
      };
      if (runLocally) {
        // Local turns do not enter the platform's Codex attempt ledger and a
        // retry must stay on the same attached machine.
        result = await dispatchLocalBuild();
        if (headless && shouldRetryHeadlessTurn(result, stopHandle, result.ahead > 0)) {
          await sendStatus('The coding step failed unexpectedly, retrying once…', executionAgentMeta);
          await waitForTurnStopped(session.id, containerName);
          result = await dispatchLocalBuild();
        }
      } else {
        // Backend-aware per-attempt dispatch (plan §7): same contract as the
      // scout path — one logical turn, one agent_turns attempt per physical
      // worker.execInWorker, and a headless auto-retry as attempt_number=2
      // that never overwrites the first attempt's usage.
      const routed = await runCodexAttemptLoop({
        pool, session, userId: req.user.id, config, isCodexSession,
        turnModel, resumeThreadId, mode: 'build',
        telemetryComponent: headless ? 'coding_agent_headless' : 'coding_agent_build',
        resolveRuntime: () => agentTurn.resolveCodexRuntimeContext({
          pool, session, userId: req.user.id, model: turnModel,
          resumeThreadId, config,
          // #3296: the platform's per-model choice of CLI.
          harness: 'auto',
        }),
        dispatchOnce: (ctx) => doBuild(ctx),
        retryPredicate: (r) => !!codexMaxTokensRetry(r, stopHandle)
          || (headless && shouldRetryHeadlessTurn(r, stopHandle, r.ahead > 0)),
        sendStatus: async (msg) => { await sendStatus(msg, executionAgentMeta); },
        waitForStopped: waitForTurnStopped,
        prepareRetry: async (retry) => {
          if (stopPendingFor(stopHandle)) return false;
          if (retry.retryFresh) {
            await worker.markTurnRetryPending(session.id, {
              turnUuid: retry.attempt.turnUuid,
              logicalTurnId: retry.logicalTurnId,
              attemptNumber: retry.attemptNumber,
            });
          } else {
            if (!retry.result?.turnId
                || !await worker.finishTurn(session.id, { turnId: retry.result.turnId })) return false;
          }
          if (stopPendingFor(stopHandle)) return false;
          worker.clearPendingStop(session.id);
          return true;
        },
        classifyAttemptStatus: ({ failed }) => stopPendingFor(stopHandle)
          ? 'cancelled'
          : (failed ? 'failed' : 'completed'),
        containerName,
      });

      if (routed?.error) {
        codexCtx = { error: routed.error };
        durableTurnId = routed.logicalTurnId || null;
        isError = true;
        // SSE is already open; terminate through the SSE protocol (review #5).
        const code = routed.error;
        const msg = code === 'backend_disabled' || code === 'backend_not_available'
          ? 'OpenRouter is not available for your account right now.'
          : code === 'model_required'
            ? 'Pick an OpenRouter model in Settings for this session.'
            : code === 'invalid_base_url'
              ? 'The OpenRouter endpoint is misconfigured.'
              : code === 'ledger_start_failed'
                ? 'Could not start the OpenRouter turn. Please retry.'
                : code === 'agent_context_changed'
                  ? 'The agent configuration changed while starting this turn. Please retry.'
                  : code === 'session_busy'
                    ? 'The session became busy. Stop the current turn before retrying.'
                    : 'Add your OpenRouter API key in Settings to use OpenRouter.';
        await sendStatus(msg, executionAgentMeta);
        if (stopHandle) {
          stopHandle.stopped = true;
          stopHandle.stoppedBy = 'agent_error';
        }
        if (typeof send === 'function') send('error', { code, error: msg });
        durableTailComplete = true;
        return { toolResultText: msg, isError: true, turnId: durableTurnId };
      }
      if (routed === null) {
        // Claude session — legacy combined path, keep the headless retry.
        result = await doBuild({});
        if (headless && shouldRetryHeadlessTurn(result, stopHandle, result.ahead > 0)) {
          await sendStatus('The coding step failed unexpectedly, retrying once…', executionAgentMeta);
          await waitForTurnStopped(session.id, containerName);
          if (!result.turnId || !await worker.finishTurn(session.id, { turnId: result.turnId })) {
            throw new Error('Could not durably finish the first build attempt before retry');
          }
          result = await doBuild({});
        }
      } else {
        result = routed.result;
        codexEstimatedCostUsd = routed.estimatedCostUsd ?? null;
      }
      }
    } catch (e) {
      // A thrown dispatch must still terminalize any in-flight Codex ledger
      // attempt (review P1): runCodexAttemptLoop completes each attempt in
      // its own try/finally, and a throw after dispatch leaves it failed. An
      // attempt-start failure is surfaced through routed.error instead of a
      // throw. Rethrow any residual so the caller's stop-branch runs.
      throw e;
    } finally {
      clearInterval(heartbeat);
      // Belt-and-braces (#891): a markerless turn (fatal error, container
      // death, a journal that never emitted [done]) never hit the
      // terminal-marker teardown above, so guarantee it here. Idempotent,
      // and it runs BEFORE the backfill so no late tick can slip a row in
      // behind the UPDATE.
      stopEstimator('turn_end');
      // Backfill the actual outcome onto this turn's estimate rows (#50
      // follow-up). Single choke point: the turn's wall clock is known
      // here and the interval is being torn down. Per-tick ground-truth
      // remaining = actual_total_ms - that tick's elapsed_ms. Outcome is
      // derived from the turn result: stopped > error > committed > noop.
      // Guarded on estimatorEnabled so non-opted runs do nothing, and
      // fire-and-forget so a DB hiccup never affects the run.
      if (estimatorEnabled) {
        const durationMs = Date.now() - turnStartedMs;
        const outcome = (stopHandle && stopHandle.stopped) ? 'stopped'
          : (!result || result.isError) ? 'error'
          : (result.ahead > 0 && result.sha) ? 'committed'
          : 'noop';
        pool.query(
          `UPDATE progress_estimates
              SET actual_total_ms = $1,
                  actual_remaining_ms = $1 - elapsed_ms,
                  outcome = $2,
                  resolved_at = NOW()
            WHERE progress_message_id = $3 AND actual_total_ms IS NULL`,
          [durationMs, outcome, progressMsgId]
        ).catch(() => {});
      }
    }

    durableTurnId = result?.turnId || null;

    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
        [newCcId, session.id]
      ).catch(() => {});
      session.cc_session_id = newCcId;
    }

    // Persist the Codex thread id for resume on the next turn (review F5).
    const buildAgentThreadId = result.agentThreadId || null;
    if (buildAgentThreadId && buildAgentThreadId !== session.agent_thread_id) {
      await pool.query(
        'UPDATE chat_sessions SET agent_thread_id = $1 WHERE id = $2',
        [buildAgentThreadId, session.id]
      ).catch(() => {});
      session.agent_thread_id = buildAgentThreadId;
    }

    // If the user stopped mid-run we want to BAIL before push/PR/staging
    // work. The container has already been docker-stopped by the /stop
    // handler, so `result` reflects whatever CC had time to emit. We
    // persist a system message noting the stop so the chat timeline
    // shows it on refresh, then return early. The `finally` below still
    // tears down the worker + clears activeWorkers.
    // #937: the post-run stop, now sharing stoppedResult() with the five
    // pre-dispatch gates. Passing `result` is what lets it report work the
    // agent had already committed before it was killed.
    if (stopPendingFor(stopHandle)) {
      isError = true;
      // #891: explicit on the stop path too. The dispatch `finally` above
      // has already run it, but a stopped run must never leave a guess
      // hanging next to "Claude Code stopped." — idempotent, so this is
      // a no-op when teardown already happened.
      stopEstimator('stopped');
      durableTailComplete = true;
      return stoppedResult(result);
    }

    ccLog = (result.rawStderr || '').substring(0, 5000) || null;
    if (ccLog?.trim()) {
      send('cc_log', { log: ccLog, ...executionAgentMeta });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, `${executionAgentName} log`, JSON.stringify({ ccLog, ...executionAgentMeta })]
      ).catch(() => {});
    }

    // #127: peel the optional "==== TESTING ====" block off the agent's
    // final message before anything downstream consumes it (Mayor summary,
    // ccOutput status, PR-metadata LLM prompt) so the raw markers never
    // leak into chat history or prompts. The parsed guidance is persisted
    // onto the session below, on the has-changes success path.
    const testing = testingNotes.extract(result.lastResultText || '');
    // #2820: then peel the OpenRouter agent's "==== DESCRIPTION ====" block
    // (the whole change so far, which becomes the proposal's description).
    // A message that was nothing but the block still gets a chat card.
    const described = proposalDescription.extract(testing.cleanedText);
    const turnDescription = described.description;
    const ccText = described.cleanedText || turnDescription || '';
    commitHash = result.sha;
    const hasChanges = result.ahead > 0 && !!commitHash;

    // #8: persist the latest behind-main count + broadcast so any open
    // dev-chat banner refreshes without waiting for the next session
    // refetch. We do this here (post-CC, before push outcome handling)
    // so the value lands even on the no-changes paths below — every
    // turn is an opportunity to learn the branch drifted.
    await persistBehindMain(pool, session, result.behind || 0);

    // Append one line to this turn's persisted progress log + live tabs.
    // Used to overwrite run-cc.sh's [push_failed] terminal marker with
    // [done] after a successful platform-side re-push heal (the card's
    // collapsed label is the log's LAST line).
    const appendTurnProgressLine = (text) => {
      send('cc_progress', { text, ...executionAgentMeta });
      return pool.query(
        `UPDATE chat_session_messages SET metadata = jsonb_set(
          metadata, '{progressLog}',
          (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
        ) WHERE id = $2`,
        [JSON.stringify([text]), progressMsgId]
      ).catch(() => {});
    };

    // Platform-side re-push heal: run-cc.sh's usernode-push callback
    // failed (push_ok=0 — e.g. a transient network/platform hiccup while
    // the worker called back). The commit exists only in the worker, so
    // re-push it from the platform side — the identical heal the restart
    // recovery path (finalizeRecoveredTurn in server.js) already uses —
    // before deciding the turn failed.
    // #1376: the heal's rejection is the only place the REAL reason for a
    // push failure exists (an invalid branch name, a missing bot token, a
    // git error from GitHub). It used to be swallowed into a WARN line and
    // replaced downstream with a fixed "retry your request" sentence, so a
    // permanently unpushable session read as a transient hiccup and the
    // user retried into the same wall. Keep it and describe it.
    let pushFailure = null;
    const healPush = async () => {
      try {
        await worker.execPushFromWorker(session.id, session.branch_name);
        result.pushOk = true;
        pushFailure = null;
        log.info('sessions', 'Push heal: re-pushed un-pushed branch', {
          sessionId: session.id, branch: session.branch_name,
        });
        await appendTurnProgressLine('[done]');
        return true;
      } catch (err) {
        pushFailure = worker.describePushFailure(err);
        log.warn('sessions', 'Push heal failed', {
          sessionId: session.id,
          branch: session.branch_name,
          code: pushFailure.code,
          permanent: pushFailure.permanent,
          err: err.message,
        });
        return false;
      }
    };

    if (result.fatalError) {
      isError = true;
      const msg = `Worker error: ${result.fatalError.substring(0, 200)}`;
      await sendStatus(msg, turnFailure(executionAgentMeta));
      summaryParts.push(msg);
    } else if (result.ccIsError && !hasChanges) {
      isError = true;
      const providerMsg = await codexProviderFailureText(pool, req.user.id, result);
      const msg = providerMsg || `${executionAgentName} error: ${(ccText || 'unknown').substring(0, 200)}`;
      await sendStatus(msg, turnFailure({
        ...executionAgentMeta,
        providerFailure: codexOpenRouter.providerFailureDiagnostics(result),
      }));
      summaryParts.push(msg);
    } else if (!hasChanges) {
      const directReply = directSessionTurn && result.exitCode === 0 && !!ccText.trim();
      if (!directReply) isError = true;
      let msg;
      if (directReply) {
        msg = null;
      } else if (result.exitCode === 0) {
        msg = `No changes were made by ${executionAgentName}.`;
      } else if (result.exitCode === -1 || result.exitCode == null) {
        // Markerless turn — say WHY in plain terms instead of a bare
        // "-1" (which also normalizes the old "code null" rendering).
        msg = `${describeMarkerlessExit(result.markerlessCause)} No changes were made.`;
      } else {
        msg = `${executionAgentName} exited with code ${result.exitCode}, so no changes were made.`;
      }
      if (msg) {
        // #3181: a clean exit that changed nothing is an answer; a run that
        // died (markerless: the worker or its process went away) or exited
        // non-zero is a failure, and is marked as one like the scout's own
        // markerless exit. That mark is also what tells the turn's done
        // hook to say "stopped before finishing" rather than "finished".
        await sendStatus(msg, result.exitCode === 0
          ? executionAgentMeta
          : turnFailure(executionAgentMeta));
        summaryParts.push(msg);
      }
    } else if (!result.pushOk && !(await healPush())) {
      // Terminal push failure (heal included): the branch on GitHub is
      // stale or absent, so PR creation would 422 and staging would
      // preview the wrong code — skip both and end the turn as a visible
      // error instead of the old easy-to-miss warning. The warm worker
      // keeps the only copy of the commit; the next turn (or a retry)
      // re-pushes it (#295), so nothing is lost.
      isError = true;
      const failure = pushFailure || worker.describePushFailure(null);
      const msg = failure.text;
      await sendStatus(msg, {
        ...turnFailure(executionAgentMeta),
        error: msg,
        pushFailureCode: failure.code,
        pushFailurePermanent: failure.permanent,
      });
      summaryParts.push(msg);
      if (failure.permanent) {
        // The Mayor writes the wrap-up from summaryParts; without this it
        // cheerfully offers "try again", which cannot work.
        summaryParts.push(
          'This push failure is permanent for this session — do NOT tell the user to retry. '
          + 'Their committed work is still in the worker and can be recovered by an admin.'
        );
      }
    } else if (headless) {
      // Success path, headless variant (#155/#183): the commit was already
      // pushed by run-cc.sh inside the worker. Persist testing guidance so
      // it carries into cloned sessions, then deliberately build a staging
      // preview so reviewers can try the change before (or without)
      // cloning — while still skipping PR creation. A code-bearing clone
      // opens a draft PR on its own branch; the auto branch stays PR-free.
      // pushOk is guaranteed here — a failed push (after the platform-
      // side heal) takes the terminal error branch above instead.
      summaryParts.push(`Commit ${commitHash.substring(0, 8)} pushed to ${session.branch_name}.`);
      if (testing.testingMd || testing.testingPath) {
        await pool.query(
          `UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4`,
          [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
        ).catch((err) => log.warn('sessions', 'Failed to persist testing guidance', { sessionId: session.id, err: err.message }));
        session.testing_md = testing.testingMd;
        session.testing_path = testing.testingPath;
        session.testing_paths = testing.testingPaths || [];
      }
      await sendStatus('Changes committed and pushed (headless). Building staging preview (no PR yet)...');

      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
      let stagingResult = null;
      let stagingErr = null;
      // #461: pend the checks for the NEW commit before the build starts, so
      // the previous commit's verdict (e.g. a stale 'passing') can't satisfy
      // the merge gate while this build runs — or after it fails.
      await visuals.setChecksPending(pool, session.id, commitHash, 'building')
        .catch((err) => log.warn('visuals', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message }));
      try {
        stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
      } catch (e) {
        stagingErr = e;
      }

      if (stagingResult) {
        await pool.query(
          `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
          [stagingResult.containerId, stagingResult.stagingUrl, session.id]
        );
        // Same edge verification as the interactive tail: persist
        // staging_url first, then make the first real request through the
        // edge before revealing the preview anywhere.
        await staging.verifyStagingEdge(session, stagingResult.hostname, stagingResult.stagingUrl);
        stagingUrl = stagingResult.stagingUrl;
        // The stagingUrl metadata is what makes this row render as the
        // "Changes ready" staging card (Preview / Test / Propose buttons)
        // in every dev chat later cloned from this auto session. The
        // explicit `changesReady: true` flag is what now DRIVES the card
        // (rather than incidentally `stagingUrl`), so the card renders the
        // same whether or not staging succeeded — see the failure branch.
        await sendStatus('Staging preview built', { stagingUrl, changesReady: true, prNumber: null });
        send('staging_ready', {
          url: stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
        summaryParts.push(`Staging preview deployed: ${stagingUrl}`);

        // #195: before/after visuals. Fire-and-forget AFTER staging_ready
        // so the preview button is never delayed; captureForSession owns
        // the UI-affecting heuristic and swallows every failure. No PR
        // exists on the headless path — the stored artifacts surface in
        // the PR body later via applyPrMetadata at promote time.
        visuals.captureForSession(config, session, app, commitHash, stagingResult, { send, trigger: 'commit-push' })
          .catch((err) => log.warn('visuals', 'Headless capture failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));
      } else {
        // Non-fatal (#183): the pushed commit is this run's deliverable; a
        // missing preview only degrades the review experience. Same
        // tailored remediation as the interactive tail so manifest/secret
        // problems surface in the Mayor's wrap-up summary — but isError
        // stays false and the run's outcome is unchanged.
        const { fix, missingKeys, errMsg, errName } = describeStagingFailure(stagingErr);
        // The commit IS pushed and reviewable — `changesReady: true` makes
        // the "Changes ready" card render (with a disabled Preview button +
        // missing-secret hint) on any clone, exactly as the success branch
        // does, instead of leaving a card-less "build failed" line. Headless
        // never opens a PR, so prNumber/prUrl are null.
        await sendStatus('Staging build failed', {
          error: errMsg,
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: errName,
          stagingMissingKeys: missingKeys,
          prNumber: null,
        });
        send('staging_failed', {
          error: errMsg,
          errorName: errName,
          missingKeys,
          changesReady: true,
          prNumber: null,
        });
        summaryParts.push(
          `Staging preview failed to build (non-fatal: commit ${commitHash.substring(0, 8)} is pushed; `
          + `a preview can be built from a cloned session).\n\n${fix}`
        );
        // #461: record the failure as a terminal 'error' checks verdict
        // (with reason + once-per-streak owner nudge) instead of leaving
        // the pending state to look "still running" forever.
        await stagingRecovery.recordStagingBootFailure({ config, pool, session, commitHash, err: stagingErr })
          .catch((e) => log.warn('staging', 'recordStagingBootFailure failed (non-fatal)', { sessionId: session.id, err: e.message }));
        log.error('staging', 'Headless staging build failed (non-fatal)', {
          sessionId: session.id, slug: app.slug, errName, err: errMsg, missingKeys,
        });
      }

      summaryParts.push(
        'Headless mode: no PR was opened. A user can start a dev-chat session from this auto session '
        + 'to review the change and propose it to the group — a draft PR opens on their cloned branch when it carries code.'
      );
    } else {
      // pushOk is guaranteed here — a failed push (after the platform-
      // side heal) takes the terminal error branch above instead.
      summaryParts.push(`Commit ${commitHash.substring(0, 8)} pushed to ${session.branch_name}.`);

      // #127: persist the turn's testing guidance BEFORE applyPrMetadata so
      // the PR body's "How to test" section (read back from the DB by id)
      // sees it. When this turn emitted a block, the latest one wins (both
      // columns overwritten — even a now-absent path); when it didn't,
      // earlier guidance is kept so a small follow-up turn doesn't wipe it.
      if (testing.testingMd || testing.testingPath) {
        await pool.query(
          `UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4`,
          [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
        ).catch((err) => log.warn('sessions', 'Failed to persist testing guidance', { sessionId: session.id, err: err.message }));
        session.testing_md = testing.testingMd;
        session.testing_path = testing.testingPath;
        session.testing_paths = testing.testingPaths || [];
      }

      // PR prose generation is another paid model call after the coding
      // agent has settled. Resolve its payer independently; when no payer is
      // current, applyPrMetadata still creates/updates the PR using its
      // deterministic draft. Durable receipts preserve a previously
      // completed generation on replay.
      let prMetadataApiKey = null;
      let prMetadataGenerationAllowed = false;
      try {
        const billing = await limits.resolveBillingPath(
          pool, config.dataEncryptionKey, req.user.id,
        );
        if (!billing.error) {
          prMetadataApiKey = billing.apiKey;
          prMetadataGenerationAllowed = true;
        } else {
          log.info('sessions', 'Using deterministic PR metadata: no payer available', {
            sessionId: session.id, reason: billing.reason || null,
          });
        }
      } catch (err) {
        log.warn('sessions', 'PR metadata billing resolve failed; using deterministic draft', {
          sessionId: session.id, err: err.message,
        });
      }
      // The external-effect receipt stores this payer as its pending intent,
      // so recovery can settle an ambiguous call without guessing.
      const prMetadataBillingByok = prMetadataGenerationAllowed && !!prMetadataApiKey;

      const wasNewPR = !session.pr_number;
      let prResult = null;
      try {
        prResult = await prMetadata.applyPrMetadata({
          pool, session, repoOwner, repoName,
          userMessage, ccSummary: ccText, username: req.user.username,
          proposalDescription: turnDescription,
          broadcast: (event, data) => send(event, data),
          apiKey: prMetadataApiKey,
          userId: req.user.id,
          effectTurnId: durableTurnId,
          effectSessionId: session.id,
          effectBillingByok: prMetadataBillingByok,
          allowModelGeneration: prMetadataGenerationAllowed,
        });
      } catch (prErr) {
        if (prErr?.retainActiveTurn) throw prErr;
        // applyPrMetadata throws typed errors ('github_unavailable' — a
        // GitHub-side outage like 2026-07-24's create-PR 500s — and, in
        // principle, 'no_commits'). None of them may abort the turn: the
        // commit and push already landed, and the staging build below
        // doesn't need the PR to exist. Tell the user and the Mayor what
        // happened instead of dying silently mid-turn.
        log.warn('sessions', 'Turn-end PR creation/update failed', {
          sessionId: session.id, code: prErr.code || null,
          ...github.describeGithubError(prErr),
        });
        if (prErr.code === 'github_unavailable') {
          await sendStatus('GitHub is having trouble creating the pull request right now (their side, not this change). It will be created when you propose, or on the next turn.');
          summaryParts.push('NOTE: GitHub\'s API is currently failing to create pull requests (GitHub-side outage). The commit is pushed and safe on the branch; the PR will be created automatically at propose time or on the next turn. Do NOT retry by dispatching extra commits — just tell the user to wait a few minutes.');
        }
      }
      if (prResult && wasNewPR) {
        const prStatus = `PR #${prResult.prNumber} created`;
        if (result.turnId) {
          const receipt = await turnEffects.runDbEffect({
            pool,
            turnId: result.turnId,
            effectKey: 'pr_opened_announcement',
            sessionId: session.id,
            run: async (client) => {
              await client.query(
                `INSERT INTO chat_session_messages (session_id, role, content, metadata)
                 VALUES ($1, 'system', $2, $3)`,
                [session.id, prStatus, JSON.stringify({})],
              );
              await client.query(
                `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
                 VALUES ($1, $2, $3, $4, $5::jsonb)`,
                [
                  req.user.id,
                  session.app_id,
                  session.id,
                  events.EVENT_TYPES.PR_OPENED,
                  JSON.stringify({ prNumber: prResult.prNumber }),
                ],
              );
              return { prNumber: prResult.prNumber };
            },
          });
          if (receipt.applied) send('status', { text: prStatus });
        } else {
          await sendStatus(prStatus);
          events.record(pool, {
            type: events.EVENT_TYPES.PR_OPENED,
            userId: req.user.id,
            appId: session.app_id,
            sessionId: session.id,
            metadata: { prNumber: prResult.prNumber },
          });
        }
        summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
        // Tail milestone: a resume must not open a second PR-opened event
        // (applyPrMetadata itself is update-safe once pr_number is set).
        await worker.noteTailMilestone(session.id, {
          prNumber: prResult.prNumber, prOpenedEventRecorded: true,
        }, { turnId: durableTurnId });
      } else if (session.pr_number && !wasNewPR) {
        summaryParts.push(`Pushed to existing PR #${session.pr_number}.`);
      }

      await sendStatus('Building staging preview...');
      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

      // Staging build is a recoverable failure point: the commit + push +
      // PR creation above already landed real-world artefacts, but the
      // preview container can still fail to come up — most commonly when
      // `dapp.json` is missing a `staging_default` for a private secret
      // (`PrivateSecretMissingStagingDefaultError`) or when a required
      // secret hasn't been set in Settings → Secrets
      // (`MissingSecretsError`). Both are user-actionable: the first is a
      // manifest edit the agent itself can apply; the second needs an
      // admin to set the value in the platform UI.
      //
      // We catch here (rather than letting the throw escape to the
      // generic chat-handler `catch`) so the failure flows back to the
      // Mayor as a `tool_result` with `is_error: true`. That's what lets
      // the wrap-up turn explain the fix to the user — and, when the
      // user nudges the agent to retry, lets the next `dispatch_claude_code`
      // see the failure context in chat history. Without this, the Mayor
      // never finds out anything went wrong; the user sees a generic
      // "Chat error" toast and has no breadcrumb to follow.
      let stagingResult = null;
      let stagingErr = null;
      // #461: pend the checks for the NEW commit before the build starts, so
      // the previous commit's verdict (e.g. a stale 'passing') can't satisfy
      // the merge gate while this build runs — or after it fails.
      await visuals.setChecksPending(pool, session.id, commitHash, 'building')
        .catch((err) => log.warn('visuals', 'setChecksPending failed (non-fatal)', { sessionId: session.id, err: err.message }));
      try {
        stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
      } catch (e) {
        stagingErr = e;
      }

      if (stagingResult) {
        await pool.query(
          `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
          [stagingResult.containerId, stagingResult.stagingUrl, session.id]
        );
        // Tail milestone: the preview for THIS commit exists. A resumed
        // tail re-checks its liveness before deciding to rebuild, so a
        // healthy container is left alone rather than rebuilt for another
        // ~5 minutes.
        await worker.noteTailMilestone(session.id, {
          stagingUrl: stagingResult.stagingUrl,
        }, { turnId: durableTurnId });

        // Make one real end-to-end request through the edge now that
        // staging_url is persisted and BEFORE emitting `staging_ready`
        // (which reveals the preview button), so the reviewer's click
        // doesn't pay the container's cold first request — and so a preview
        // the edge can't actually route to is visible in the platform log
        // rather than only to whoever clicks it. Bounded; never blocks the
        // deploy.
        await staging.verifyStagingEdge(session, stagingResult.hostname, stagingResult.stagingUrl);

        stagingUrl = stagingResult.stagingUrl;
        // `changesReady: true` is now what drives the "Changes ready" card
        // (rather than incidentally `stagingUrl`), so the same card renders
        // on the staging-failed branch below. prNumber/prUrl ride along so
        // the card header + "View on GitHub" survive a reload from metadata.
        await sendStatus('Staging deployed!', {
          stagingUrl,
          changesReady: true,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
        });
        // #127: ship the session's testing guidance (this turn's block, or
        // the kept-previous one off the session row) alongside the staging
        // URL so the client can offer "Test this change" without a refetch.
        send('staging_ready', {
          url: stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
        summaryParts.push(`Staging redeployed: ${stagingUrl}`);

        // #195: before/after visuals. Fire-and-forget AFTER staging_ready
        // so the preview button is never delayed. When the capture lands
        // it patches the PR body's "Before / after" block directly and
        // emits visuals_ready (via this turn's send → SSE/WS/bus) so the
        // staging card upgrades in place.
        visuals.captureForSession(config, session, app, commitHash, stagingResult, { send, trigger: 'commit-push' })
          .catch((err) => log.warn('visuals', 'Capture failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));

        if (session.status === 'promoted') {
          // Tail milestone BEFORE the work, not after: the vote reset is
          // the one tail step that is not idempotent in what it SAYS (it
          // announces itself and asks people back). A resumed tail must not
          // re-announce a reset for a commit whose votes are already retired,
          // so claim it up front — a crash between the stamp and the retire
          // leaves at worst an unannounced reset, which the next push redoes
          // anyway.
          await worker.noteTailMilestone(
            session.id,
            { votesResetFor: commitHash },
            { turnId: durableTurnId },
          );
          // #788: the new commit may have added or removed a name in
          // dapp.json's `admins` block, so re-classify alongside the
          // vote reset. Best-effort (swallows GitHub failures) and
          // re-verified authoritatively in checkAndMerge.
          await require('../services/app-admins')
            .refreshExplicitApproval(pool, session, session);
          // #1688: the votes are RETIRED, not deleted — the session's approval
          // epoch moves on and the rows stay as the record of who was on
          // board, which is what asks the prior Yes voters back with one tap
          // (services/vote-revision.js).
          const { sendSystemMessage, pushVoteUpdate } = require('../services/ws');
          const retired = await require('../services/vote-revision').retireAndRecheck(
            pool, session, commitHash,
            {
              announce: async ({ retired: dropped }) => {
                pushVoteUpdate({
                  sessionId: session.id,
                  appSlug: session.app_slug,
                  merged: false,
                });
                const resetMsg = `An update was pushed to PR #${session.pr_number || session.id} (commit ${commitHash.substring(0, 8)}). Earlier votes were on the old version, so take another look.`;
                // Into the proposal's thread (lifecycle in context).
                await sendSystemMessage(pool, session.app_id, resetMsg, 'system',
                  null, { type: 'session', ref: session.id }).catch(() => {});
                log.info('sessions', 'Retired PR votes after new commit', {
                  sessionId: session.id, commitHash: commitHash.substring(0, 8), votesRetired: dropped,
                });
              },
            },
          );
          if (retired.retired > 0) {
            summaryParts.push('Group-chat votes were reset for the new commit.');
          }
        }

        if (session.pr_number && repoOwner && repoName) {
          try {
            const pat = process.env.GITHUB_BOT_TOKEN;
            if (pat) {
              const { Octokit } = await import('@octokit/rest');
              const ok = new Octokit({ auth: pat });
              // #127: append the "How to test" section so the guidance is
              // visible right where reviewers find the staging link.
              const testingComment = prMetadata.buildTestingBlock(session.testing_md, session.testing_path);
              await ok.rest.issues.createComment({
                owner: repoOwner, repo: repoName,
                issue_number: session.pr_number,
                body: github.safeMention(`**Staging deployed!**\n\n${stagingResult.stagingUrl}\n\nCommit: ${commitHash.substring(0, 8)}${testingComment ? `\n\n${testingComment}` : ''}`),
              });
            }
          } catch (commentErr) {
            log.warn('sessions', 'Failed to comment on PR', { err: commentErr.message });
          }
        }

        log.info('sessions', 'Full dev cycle complete', { sessionId: session.id, commitHash: commitHash.substring(0, 8) });
      } else {
        isError = true;

        const { fix, missingKeys, errMsg, errName } = describeStagingFailure(stagingErr);

        const message =
          `Staging build failed.\n\n` +
          `What still happened: commit ${commitHash.substring(0, 8)} was pushed to ${session.branch_name}` +
          (session.pr_number ? ` and PR #${session.pr_number} was created/updated` : '') +
          `. Only the staging preview container is missing, so there is no preview URL for this commit.\n\n` +
          fix;

        // The commit (and PR, if any) already landed — `changesReady: true`
        // keeps the "Changes ready" card + Propose button on screen (with a
        // disabled Preview button and the missing-secret hint), so a failed
        // preview no longer hides a perfectly proposable change. Propose
        // rebuilds staging itself (routes/votes.js), so this stays usable.
        await sendStatus('Staging build failed', {
          error: errMsg,
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: errName,
          stagingMissingKeys: missingKeys,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
        });
        send('staging_failed', {
          error: errMsg,
          errorName: errName,
          missingKeys,
          changesReady: true,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
        });
        summaryParts.push(message);

        // #461: record the failure as a terminal 'error' checks verdict
        // (with reason + once-per-streak owner nudge) instead of leaving
        // the pending state to look "still running" forever.
        await stagingRecovery.recordStagingBootFailure({ config, pool, session, commitHash, err: stagingErr })
          .catch((e) => log.warn('staging', 'recordStagingBootFailure failed (non-fatal)', { sessionId: session.id, err: e.message }));

        log.error('staging', 'Staging build failed (surfaced to Mayor)', {
          sessionId: session.id,
          slug: app.slug,
          errName,
          err: errMsg,
          missingKeys,
        });
      }
    }

    // Debit the daily ledger for whatever Claude Code spent — even when
    // the run produced no commit (CC error, no-op turn, partial-failure
    // with `result.fatalError`). The Anthropic invoice is paid
    // regardless of whether code changes landed; without this we'd
    // silently let users burn budget on tool-only / failed turns and
    // only debit on the success branch. BYOK runs were billed to the
    // user's own key by the worker, so they land in the display-only
    // byok bucket instead of the capped one (#119 — this site used to
    // debit BYOK runs against the platform limit by mistake).
    if (isCodexSession) {
      // Codex/OpenRouter spend is billed to the user's OpenRouter account
      // directly (review #3) — never the Anthropic llm_usage ledger. It is
      // recorded on agent_turns by completeCodexAttempt, and what the chat
      // gets is that ledger estimate (#2118). A direct session turn's
      // receipt is the caller's to send, after its reply row is on screen:
      // sent from here it would precede the completion status line below,
      // and the client attaches a usage event to the bubble a status line
      // then discards.
      if (!directSessionTurn && codexEstimatedCostUsd != null && codexEstimatedCostUsd > 0) {
        const cents = codexCostCents(codexEstimatedCostUsd);
        // #2571: the included key's spend is platform money and joins the
        // shared weekly pool; a personal key's does not. See
        // sharedPoolCodexSpend.
        const pooled = await sharedPoolCodexSpend(pool, req.user.id, cents);
        send('usage', {
          costCents: cents,
          model: `codex-openrouter/${turnModel}`,
          byok: !pooled,
          estimated: true,
        });
      }
    } else if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      // #664: split across buckets — the worker proxy may have switched
      // this platform-dispatched turn onto the owner's key mid-run.
      const split = await limits.settleTurnSpend(pool, req.user.id, ccCostCents, {
        turnByok: !!userApiKey,
        byokObservedCents: worker.getTurnByokCents(session.id),
        turnId: result.turnId || null,
        sessionId: session.id,
      });
      if (split.platformCents > 0) send('usage', { costCents: split.platformCents, model: `claude-code/${selectedModel}`, byok: false });
      if (split.byokCents > 0) send('usage', { costCents: split.byokCents, model: `claude-code/${selectedModel}`, byok: true });
    }

    if (ccText) {
      // Outcome-aware completion row (#358): the green "Claude Code finished"
      // card + the [CODING AGENT COMPLETED] fold-in are reserved for runs
      // that actually changed code. A run that committed nothing (no-op) or
      // errored gets an honest header instead, and a ccOutcome discriminator
      // so buildMayorMessages labels the Mayor's context accordingly — a
      // no-op/failure must never masquerade as a completed build.
      const ccOutcome = hasChanges
        ? 'success'
        : ((result.fatalError || result.ccIsError) ? 'error' : 'no_changes');
      let statusText = ccOutcome === 'success'
        ? `${executionAgentName} finished`
        : ccOutcome === 'no_changes'
          ? (directSessionTurn ? `${executionAgentName} replied` : `${executionAgentName} made no changes`)
          : `${executionAgentName} did not complete`;
      // #907: name the machine and say plainly that the platform did not pay
      // for the coding phase. The scout path's counterpart reads "Drafted on
      // …"; the two together are how a reader of the transcript tells a local
      // spec turn from a local build turn months later.
      if (runLocally) {
        statusText += ` Coding done on ${lease.label}, so no Homeroom credits were used.`;
      }
      const completionMeta = {
        ...executionAgentMeta,
        ccOutput: ccText,
        ...(turnDescription ? { proposalDescription: turnDescription } : {}),
        ccOutcome,
        durationMs: Date.now() - turnStartedMs,
        ...(runLocally
          ? { runner: 'local', localAgentLabel: lease.label, localMode: 'build' }
          : {}),
      };
      const directChatReply = directSessionTurn && !hasChanges && !isError;
      if (!directChatReply) {
        if (result.turnId) {
          const receipt = await turnEffects.runDbEffect({
            pool,
            turnId: result.turnId,
            effectKey: 'completion_row',
            sessionId: session.id,
            run: async (client) => {
              await client.query(
                `INSERT INTO chat_session_messages (session_id, role, content, metadata)
                 VALUES ($1, 'system', $2, $3)`,
                [session.id, statusText, JSON.stringify(completionMeta)],
              );
              return { persisted: true };
            },
          });
          if (receipt.applied) send('status', { text: statusText, ...completionMeta });
        } else {
          await sendStatus(statusText, completionMeta);
        }
      }
      // Tail milestone: the agent's own summary card is on the transcript.
      // A resumed tail must not post a second one (finalizeRecoveredTurn's
      // persistCompletionRow is otherwise unconditional).
      await worker.noteTailMilestone(
        session.id,
        { completionRowPosted: true },
        { turnId: durableTurnId },
      );
      // Prepend CC's own description so the Mayor leads with what was
      // actually built, with our outcome bullets as supplementary context.
      summaryParts.unshift(directChatReply ? ccText : `What the agent did:\n${ccText}`);
    }
    durableTailComplete = true;
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    if (durableTailComplete && durableTurnId && typeof beforeTurnCleanup === 'function') {
      try {
        await beforeTurnCleanup({ turnId: durableTurnId, isError, commitSha: commitHash || null });
      } catch (err) {
        err.retainActiveTurn = true;
        throw err;
      }
    }
    if (durableTailComplete && durableTurnId && (!deferTurnCleanup || headless)) {
      await finishToolTurnCleanup(session.id, durableTurnId, { required: headless });
    } else {
      if (!durableTailComplete) {
        log.warn('sessions', 'Build tail failed; retaining durable turn for recovery', {
          sessionId: session.id,
        });
      }
    }
    // #907: persist the execution venue after the durable worker lifecycle
    // has either completed or been retained for recovery.
    await localAgent.recordTurnRunner(
      pool, session.id, runLocally ? 'local' : 'platform', lease?.label
    );
    if (runLocally) {
      localAgent.recordTurnEvent(pool, {
        userId: session.user_id,
        appId: session.app_id,
        sessionId: session.id,
        mode: 'build',
        outcome: isError ? 'failed' : (commitHash ? 'completed' : 'no_changes'),
        runtime: lease.runtime,
        durationMs: Date.now() - turnStartedMs,
      });
    }
    // Turn completion counts as activity: a fresh idle window so the
    // auto-pause sweeper can't pause the session moments after a long
    // build finishes (its last_activity_at is otherwise still the user
    // message that started it).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    // Warm container intentionally NOT destroyed — the next dispatch
    // (build or scout) reuses it. Idle eviction (worker.evictWorker via
    // the sweeper in server.js) and session archive own teardown.
  }

  // #2641: "long GLM responses seem to be getting truncated". They were,
  // here. The 4000-character bound is a PROMPT bound — this text goes back
  // to the Mayor as tool_result content, and an unbounded agent summary
  // would crowd out its context.
  //
  // A DIRECT SESSION TURN has no Mayor. It is the single-provider
  // OpenRouter path, and its own comment says so: "no Anthropic Mayor,
  // wrap-up, or quick-reply generation runs around it". Nothing re-prompts
  // with this string; the caller writes it straight into
  // `chat_session_messages.content` — a TEXT column with no limit of its
  // own — as the assistant's message, for the person who asked to read.
  //
  // So a reply of about six hundred words was silently cut mid-sentence,
  // which is exactly the "not even that long" in the report. The bound now
  // applies only where there is a prompt to bound.
  //
  // Keyed on `directSessionTurn`, NOT on whether the turn happened to
  // change files: a build turn on this path persists the same text just as
  // directly, so a long build summary was cut in exactly the same way.
  const summaryText = summaryParts.join('\n\n');
  const fallbackSummary = isError
    ? `${executionAgentName} did not complete successfully.`
    : `${executionAgentName} finished with no summary.`;
  const toolResultText = (directSessionTurn
    ? summaryText
    : summaryText.slice(0, MAYOR_TOOL_RESULT_CHAR_MAX)) || fallbackSummary;
  // commitSha is exposed (in addition to ccLog/stagingUrl) for the
  // caller's bookkeeping (PR card metadata, etc.). Null if CC made no
  // changes.
  return {
    toolResultText,
    ccLog,
    stagingUrl,
    isError,
    commitSha: commitHash || null,
    turnId: durableTurnId,
    // #2118: an OpenRouter turn's ledger estimate in fractional cents, for
    // the direct-turn caller's reply row and usage receipt. Null for a
    // Claude turn (settled above) and for an unpriced model.
    estimatedCostCents: codexEstimatedCostUsd != null && codexEstimatedCostUsd > 0
      ? codexCostCents(codexEstimatedCostUsd)
      : null,
  };
}

async function getFilesFromContainer(appSlug) {
  const containerName = `usernode-app-${appSlug}`;
  try {
    // List files in the container's /app directory
    const { stdout: fileList } = await docker.execFileAsync('docker', [
      'exec', containerName, 'find', '/app', '-type', 'f',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.git/*',
      '-not', '-name', 'package-lock.json',
    ], { timeout: 10000 });

    const files = fileList.trim().split('\n').filter(Boolean).slice(0, 20);
    const contents = [];

    for (const filePath of files) {
      try {
        const { stdout } = await docker.execFileAsync('docker', [
          'exec', containerName, 'cat', filePath,
        ], { timeout: 5000 });
        const relativePath = filePath.replace('/app/', '');
        if (stdout.length < 50000) {
          contents.push(`--- ${relativePath} ---\n${stdout}`);
        }
      } catch {}
    }

    if (contents.length > 0) {
      log.info('sessions', 'Loaded file context from container', { container: containerName, fileCount: contents.length });
      return contents.join('\n\n');
    }
  } catch (err) {
    log.warn('sessions', 'Failed to read files from container', { container: containerName, err: err.message });
  }
  return null;
}

function parseFileChanges(text) {
  const files = [];
  const regex = /```\w*:?([\w/._-]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1];
    const content = match[2];
    if (path && content && !path.match(/^\d+$/)) {
      files.push({ path, content });
    }
  }
  return files;
}

async function buildStagingFromFiles(config, session, app, fileChanges, hash) {
  const fs = require('fs');
  const path = require('path');
  const dbManager = require('../services/db-manager');

  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${hash.substring(0, 6)}`;

  log.info('sessions', 'Building staging from chat files', { sessionId: session.id });

  // Get the current production app's files as a base
  const prodContainer = `usernode-app-${app.slug}`;
  const tempDir = `/tmp/usernode-staging-build-${session.id}`;

  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
  fs.mkdirSync(tempDir, { recursive: true });

  // Copy files from production container as a base
  try {
    await docker.execFileAsync('docker', ['cp', `${prodContainer}:/app/.`, tempDir], { timeout: 30000 });
  } catch (err) {
    log.warn('sessions', 'Could not copy from production container, using empty base', { err: err.message });
  }

  // Remove node_modules from copy (we'll npm install fresh)
  await docker.execFileAsync('rm', ['-rf', path.join(tempDir, 'node_modules')]).catch(() => {});

  // Apply the AI's file changes on top
  for (const file of fileChanges) {
    const filePath = path.join(tempDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }

  // Ensure Dockerfile exists.
  //
  // This is the platform emitting a Dockerfile on an app's behalf, so it owes
  // the same contract the app template does (services/template.js): a NUMERIC
  // non-zero USER, and ownership of the copied tree. Kubernetes runs app and
  // preview pods with runAsNonRoot and no runAsUser, so an image that names no
  // user runs as root and the kubelet refuses to start it —
  // `CreateContainerConfigError: container has runAsNonRoot and image will run
  // as root`. This path builds for the Docker runtime, where that is not
  // enforced, which is exactly why it drifted: it kept emitting the old shape
  // long after the template stopped. `tests/generated-dockerfile-user.test.js`
  // holds every generator here to the same rule so the two cannot diverge
  // again (#2302).
  if (!fs.existsSync(path.join(tempDir, 'Dockerfile'))) {
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), `FROM node:22-alpine
WORKDIR /app
COPY --chown=1000:1000 package.json ./
RUN npm install --production
COPY --chown=1000:1000 . .
EXPOSE 3000
USER 1000:1000
CMD ["node", "server.js"]
`);
  }

  // Build
  await docker.buildImage(tempDir, imageName);
  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

  // Clone DB. cloneDatabase mints a fresh per-clone postgres role —
  // see staging.js for the rationale (one-shot password, dropped on
  // teardown, never persisted on the platform).
  const prodDbName = dbManager.appDbName(app.slug);
  const stagingDbName = dbManager.stagingDbName(app.slug, `s${session.id}`, hash);
  const { password: stagingDbPassword } = await dbManager.cloneDatabase(prodDbName, stagingDbName);
  const stagingDbUrl = dbManager.connectionUrl(stagingDbName, stagingDbPassword);

  // Stop old staging
  await docker.stopAndRemove(containerName).catch(() => {});

  // Run
  const containerId = await docker.runContainer(containerName, {
    image: imageName,
    env: {
      DATABASE_URL: stagingDbUrl,
      ...appIdentityEnv(app, config),
      PORT: '3000',
    },
    port: 3000,
  });

  await docker.waitForHealthy(containerName, 3000, '/health');

  // Get the host port for local dev access
  const hostPort = await docker.getHostPort(containerName, 3000);
  // No Caddy route to register — the wildcard site maps this hostname to
  // `containerName` (usernode-staging-<slug>--<id>) and issues TLS
  // on-demand. See Caddyfile + services/caddy.js.
  const hostname = caddy.stagingHostname(app.slug, `s${session.id}`);

  const stagingUrl = hostPort
    ? `http://localhost:${hostPort}`
    : `https://${hostname}`;

  // Edge verification happens in the caller (staging.verifyStagingEdge)
  // AFTER the session's staging_url is persisted — that persist is what
  // makes the hostname a referenceable preview. See staging.js for the full
  // ordering rationale.

  return { containerId, stagingUrl, hostname };
}

// The routes/sessions.js helpers a Mayor turn calls (services/mayor/turn.js,
// #2779). Handed over rather than required from there, which would be a
// require cycle.
const MAYOR_TURN_DEPS = Object.freeze({
  TURN_WRAPUP_EFFECT_KEYS,
  buildOpenProposalsBlock,
  buildSessionDiscussionBlock,
  codingAgentRuntimeIdentity,
  describeTurnError,
  invocationTelemetry,
  loadSessionSpec,
  notifySessionDone,
  notifySessionStalled,
  runClaudeCodeTool,
  runScoutTool,
  safeAgentModelLabel,
  scheduleRetainedInteractiveTurn,
  sharedPoolCodexSpend,
  snapshotMayorResponse,
  staticWrapUpText,
  switchSessionAgent,
});

module.exports = { requestSessionStop, MAYOR_TURN_DEPS, canViewSession, BUILD_VENUES, summarizeFailingChecks, describeStoppedLanding, stopLandingMeta, runCodexAttemptLoop, resumeRecoveredCodexFreshRetry, sessionRoutes, getActiveWorkerCount, runSyncMain, persistBehindMain, buildSpecPreview, buildOpenProposalsBlock, buildFailingChecksBlock, buildSessionDiscussionBlock, postHeadlessQuestionThreadMessage, stripSpecWrapperFence, snapshotSessionSpec, persistScoutPublication, scheduleRetainedInteractiveTurn, resumeHeadlessRuns, runRecoveredWrapUp, describeStagingFailure, notifySessionDone, notifySessionStalled, notifyAutoSolveDone, buildHeadlessSeed, buildHeadlessDecisionAddendum, buildHeadlessFollowUpMessage, buildHeadlessFollowUpQuickReplies, shouldPostHeadlessQuestionComment, specHasBlockingQuestions, sanitizeSuggestedAnswers, resolveSuggestedAnswers, sanitizeQuickReplies, resolveQuickReplies, shouldFallbackQuickReplies, resolveTurnPills, quickReplyMeta, headlessWrapUpMeta, salvageAssistantText, needsEmptyReplyFallback, shouldRepromptForDataSummary, buildDataSummaryReprompt, DATA_SUMMARY_FALLBACK_TEXT, describeTurnError, describeMarkerlessExit, shouldRetryHeadlessTurn, shouldRetryApiErrorTurn, codexMaxTokensRetry, codexProviderFailureText, stripFakeCompletionMarker, buildMayorMessages, buildCodingAgentConventionsContext, buildHostedCodingWorkflowGuidance, buildCodingAgentBuildGuidance, OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE, buildCodingAgentSpecContext, canReuseHostedClaudeScoutSpec, CODING_AGENT_COMPLETED_MARKER, getMayorSystemPrompt, DATA_TOOL_NAMES, IN_PROCESS_TOOL_NAMES, DRAFT_TOOL_NAME, GET_PROD_STATUS_TOOL, GET_GITHUB_ISSUE_TOOL, LIST_GITHUB_ISSUES_TOOL, DRAFT_ISSUE_REPORT_TOOL, SUGGEST_REPLIES_TOOL, resolveDataToolResult, resolveProdStatusToolResult, dataToolStatusLine, DATA_TOOL_THINKING_STATUS, codingAgentRuntimeIdentity, resolveDefaultAgentPreference, resolveExplicitAgentPreference, AgentSelectionError, switchSessionAgent, resumePausedSession, _recordLocalCodingInvocationForTests: recordLocalCodingInvocation };
