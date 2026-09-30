'use strict';

// Dispatching the coding agent from an agent session (#2779, spec:
// docs/agent-sessions.md, "Coding agent" and "Lifecycle and limits").
//
// An agent session has no worker of its own. It builds on its ACTIVE change,
// through exactly the machinery a classic session's Mayor uses:
// runScoutTool and runClaudeCodeTool in routes/sessions.js, handed over as
// MAYOR_TURN_DEPS. Everything that makes a change a change stays theirs: the
// worker, the durable turn record, the PR, staging, checks, the vote
// revision, the coding agent's spend. This module does only what the classic
// chat route does around them:
//
//   - finds the active change and refuses one that cannot take a dispatch
//     (none, merged, archived, busy);
//   - reopens a parked change through the platform's own resume route, on a
//     one-action grant, so the caps and the LRU pause apply as they do for
//     the browser;
//   - claims the change's one-operation guard and registers a stop handle in
//     the shared stop registry, so POST /api/sessions/:changeId/stop (and its
//     kill confirmation and force escalation) stops the run;
//   - streams the run's events to the conversation AND to the change's own
//     channels (its bus key and the global WebSocket), so the change page and
//     the Dev board see a build started from a conversation like any other;
//   - defers the durable turn cleanup to after the conversation's wrap-up,
//     so a restart during the wrap-up is recovered the classic way.

const log = require('../logger');
const registry = require('../../agents/registry');

const DISPATCH_KINDS = Object.freeze({ dispatch_scout: 'scout', dispatch_coding_agent: 'build' });
const LIVE_STATUSES = new Set(['active', 'promoted']);
const RESUMABLE_STATUSES = new Set(['paused']);
// The same three types a classic turn keeps off the global WebSocket.
const SSE_ONLY = new Set(['token', 'usage', 'error']);
const CHANGE_ONLY = new Set(['done', 'stopped']);
// A shots run holds the change's worker for its two to four
// minutes without being a turn, so a dispatch waits it out, this long at most.
const SHOTS_WAIT_MS = 6 * 60_000;
const BUSY_TEXT = 'busy: the coding agent is already working on this change. Wait for it to finish.';
const SHOTS_BUSY_TEXT = 'busy_shots: the platform\'s shots agent is still recording '
  + 'before/after screenshots on this change and holds its worker. It is not the coding agent and is not working '
  + 'on this request. Nothing was built, and nothing will retry it automatically: tell the user so, and to send '
  + 'the request again in a few minutes.';

const SCOUT_TOOL = Object.freeze({
  name: 'dispatch_scout',
  description: 'Dispatch the coding agent in read-only PLAN MODE on the ACTIVE change, to investigate its app\'s '
    + 'repository and draft or revise the change\'s spec. Use for all spec work: the first draft and every revision. '
    + 'It reads files and writes prose; it cannot edit, commit or push. Slow (about a minute). Only when there is an '
    + 'active change; at most one dispatch per turn.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What the scout should investigate, or exactly what to change in the existing spec (which is '
          + 'given to it already; do not restate it). 1-3 sentences.',
      },
    },
    required: ['prompt'],
  },
});

const BUILD_TOOL = Object.freeze({
  name: 'dispatch_coding_agent',
  description: 'Dispatch the coding agent on the ACTIVE change to make the code change: it edits the app\'s '
    + 'repository on the change\'s branch, commits and pushes, and the platform rebuilds the preview and runs the '
    + 'checks. Use only when the user has asked for a concrete change to be built. The change\'s spec is given to the '
    + 'agent already: say which slice to build now, not the whole spec again. When the user asked to build the spec, '
    + 'the slice is all of it. Only when there is an active change; at most one dispatch per turn.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What the coding agent should build or fix right now: what to change, where, and the expected '
          + 'behaviour. No code. 1-4 sentences.',
      },
    },
    required: ['prompt'],
  },
});

function isDispatchTool(name) {
  return Object.prototype.hasOwnProperty.call(DISPATCH_KINDS, name);
}

function defaults(deps = {}) {
  return {
    turnDeps: deps.turnDeps || null,
    worker: deps.worker || require('../worker'),
    activeWorkers: deps.activeWorkers || require('../active-workers'),
    stopRegistry: deps.stopRegistry || require('../stop-registry'),
    sessionBus: deps.sessionBus || require('../session-bus'),
    broadcastGlobal: deps.broadcastGlobal || ((payload) => require('../ws').broadcastGlobal(payload)),
    models: deps.models || require('../models'),
    agentSessions: deps.agentSessions || require('../agent-sessions'),
    mcpOauth: deps.mcpOauth || require('../mcp-oauth'),
    callPlatform: deps.callPlatform || require('../mcp-tools').callPlatform,
    loopbackBaseUrl: deps.loopbackBaseUrl || require('./mcp-shim').loopbackBaseUrl,
    attachments: deps.attachments || require('../attachments'),
    shotsRunFor: deps.shotsRunFor
      || ((id) => require('../shots-orchestrator').inFlightRunFor(id)),
    shotsWaitMs: deps.shotsWaitMs ?? SHOTS_WAIT_MS,
  };
}

// 'idle' once a shots run that was the only thing holding the
// change has ended; 'timeout' when it outlasts the wait; 'busy' when a turn
// or an operation holds the change, before or after.
async function waitOutShotsRun(d, changeId, sendAgent) {
  const heldByTurn = () => d.activeWorkers.hasSessionOperation(changeId) || d.activeWorkers.activeWorkers.has(changeId);
  if (heldByTurn()) return 'busy';
  const run = d.shotsRunFor(changeId);
  if (!run) return 'busy';
  sendAgent('status', {
    text: 'Before & after shots is being recorded on this change. The coding agent starts when it finishes.',
    changeId,
  });
  let timer = null;
  const finished = await Promise.race([
    run.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), d.shotsWaitMs); }),
  ]);
  clearTimeout(timer);
  if (!finished) return 'timeout';
  return d.activeWorkers.isSessionBusy(changeId) ? 'busy' : 'idle';
}

// MAYOR_TURN_DEPS lives in routes/sessions.js, which requires the Mayor
// modules at load. Read at call time, never at load, so there is no cycle.
function turnDepsOf(d) {
  if (d.turnDeps) return d.turnDeps;
  return require('../../routes/sessions').MAYOR_TURN_DEPS;
}

// The conversation's active change, as the classic chat route loads a
// session (`cs.*` plus the app columns the tools read), or null.
async function loadActiveChange(pool, { agentSessionId, userId }) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted AS app_self_hosted
       FROM agent_sessions s
       JOIN chat_sessions cs ON cs.id = s.active_change_id
       JOIN apps a ON a.id = cs.app_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.status = 'open' AND cs.user_id = $2`,
    [agentSessionId, userId]
  );
  return rows[0] || null;
}

// Whether the active change can take a dispatch this turn. The tools are
// offered only then, the same rule a classic session applies to a busy
// worker.
function canDispatch(change, deps = {}) {
  const d = defaults(deps);
  if (!change) return false;
  if (!LIVE_STATUSES.has(change.status) && !RESUMABLE_STATUSES.has(change.status)) return false;
  if (!/github\.com\/[^/]+\/[^/]+/.test(change.repo_url || '')) return false;
  const id = Number(change.id);
  if (!d.activeWorkers.isSessionBusy(id)) return true;
  // Held only by a shots run: the dispatch waits it out.
  return !d.activeWorkers.hasSessionOperation(id) && !d.activeWorkers.activeWorkers.has(id)
    && !!d.shotsRunFor(id);
}

// Reopen a parked change through POST /api/sessions/:id/resume, as the user,
// on a write grant bound to the change and revoked as soon as it answers.
async function resumeChange({ pool, config, userId, agentSessionId, change, d }) {
  const grant = await d.mcpOauth.issueDelegatedAccess(pool, {
    userId,
    kind: 'agent_mayor',
    agentSessionId,
    appId: change.app_id,
    changeId: change.id,
    scopes: ['usernode:apps:read', 'usernode:proposals:write'],
    ttlSeconds: 60,
  });
  try {
    const answer = await d.callPlatform(
      d.loopbackBaseUrl(config), grant.accessToken, 'POST', `/api/sessions/${change.id}/resume`, {}
    );
    if (answer.ok) return { ok: true };
    const said = answer.body && (answer.body.error || answer.body.message);
    return { ok: false, message: said || `Homeroom returned HTTP ${answer.status}.` };
  } finally {
    await d.mcpOauth.revokeDelegation(pool, { grantId: grant.grantId, reason: 'action_done' }).catch((err) => {
      log.warn('agent-mayor', 'Could not revoke the resume grant', { changeId: change.id, err: err.message });
    });
  }
}

// The model the coding agent runs on. A Codex change carries its own; a
// Claude change runs on the conversation's Claude choice when it has one,
// else its pinned model, else the platform default.
function codingModelFor(change, d, choice = null) {
  if (change.agent_backend === 'codex_openrouter') return d.models.resolve(null);
  const chosen = choice && choice.backend === 'claude_code' ? choice.model : null;
  return d.models.resolve(chosen || change.agent_model || null);
}

// Whether the active change has to be switched to the conversation's choice
// before this build. A different backend always does; for OpenRouter a
// different model or reasoning effort does too, because both are fixed for a
// Codex thread. A Claude model is not: it is chosen per run (codingModelFor),
// as the dev chat's picker chooses it per turn.
function needsAgentSwitch(change, choice) {
  if (!choice) return false;
  const current = registry.resolveBackend(change.agent_backend);
  if (current !== choice.backend) return true;
  if (choice.backend !== 'codex_openrouter') return false;
  return (change.agent_model || null) !== (choice.model || null)
    || (change.agent_reasoning_effort || null) !== (choice.reasoningEffort || null);
}

// The dev chat's own reset (POST /api/sessions/:id/reset-agent-context):
// the change keeps its branch and conversation, starts a fresh agent context
// and says so in its own transcript.
function agentPrefFor(choice) {
  const codex = choice.backend === 'codex_openrouter';
  return {
    backend: choice.backend,
    provider: codex ? 'openrouter' : 'anthropic',
    model: codex ? choice.model : null,
    reasoningEffort: codex ? (choice.reasoningEffort || null) : null,
  };
}

function refusal(text) {
  return { ran: false, isError: true, toolResultText: text };
}

// Run one dispatch on the active change. Resolves when the run and its tail
// are over. `finish()` on the result releases the durable turn and must be
// called once the conversation's wrap-up is written (or skipped).
async function runDispatch({
  pool,
  config,
  user,
  agentSessionId,
  kind,
  prompt,
  userMessage,
  // The files the user sent with the message this build is for
  // (agent-turn.js dispatchAttachmentIds): named in the prompt as the dev
  // chat names them, text inlined and the rest fetched with
  // `usernode-attachments`, which reads a conversation's files through the
  // change it builds (routes/internal.js).
  attachmentIds = [],
  apiKey = null,
  sendAgent,
  res,
  onStopHandle = () => {},
  shouldStop = async () => false,
  scheduleInteractiveRecovery = null,
  deps = {},
}) {
  const d = defaults(deps);
  const stoppedBeforeStart = () => ({ ran: false, isError: false, stopped: true, finish: async () => {} });
  if (await shouldStop()) return stoppedBeforeStart();
  let change = await loadActiveChange(pool, { agentSessionId, userId: user.id });
  if (!change) {
    return refusal('no_active_change: there is no active change. Start one (start_change) or switch to one first.');
  }
  if (!LIVE_STATUSES.has(change.status) && !RESUMABLE_STATUSES.has(change.status)) {
    return refusal(`change_closed: change ${change.id} is ${change.status}, so the coding agent cannot run on it.`);
  }
  const [, repoOwner, repoName] = (change.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!repoOwner || !repoName) {
    return refusal('no_repository: the app has no GitHub repository yet. The platform repairs this automatically; '
      + 'try again in a few minutes.');
  }
  const changeId = Number(change.id);
  if (d.activeWorkers.isSessionBusy(changeId)) {
    const waited = await waitOutShotsRun(d, changeId, sendAgent);
    if (waited === 'timeout') return refusal(SHOTS_BUSY_TEXT);
    if (waited !== 'idle') return refusal(BUSY_TEXT);
    change = await loadActiveChange(pool, { agentSessionId, userId: user.id });
    if (!change || Number(change.id) !== changeId
        || (!LIVE_STATUSES.has(change.status) && !RESUMABLE_STATUSES.has(change.status))) {
      return refusal('change_closed: the active change moved on while before & after shots was being recorded; nothing was built.');
    }
  }
  if (RESUMABLE_STATUSES.has(change.status)) {
    const resumed = await resumeChange({ pool, config, userId: user.id, agentSessionId, change, d });
    if (!resumed.ok) return refusal(`resume_failed: the change is parked and could not be reopened. ${resumed.message}`);
    change = await loadActiveChange(pool, { agentSessionId, userId: user.id });
    if (!change || !LIVE_STATUSES.has(change.status)) {
      return refusal('resume_failed: the change is parked and could not be reopened.');
    }
  }

  const turnDeps = turnDepsOf(d);
  // The conversation's model choice applies from the next build: switch the
  // change to it now, before the operation guard is claimed (the switch
  // refuses a busy change). If the switch fails, report it rather than
  // silently starting another build with the model the user replaced.
  const choice = await d.agentSessions.getAgentChoice(pool, agentSessionId);
  if (needsAgentSwitch(change, choice)) {
    const switched = await turnDeps.switchSessionAgent(pool, {
      sessionId: changeId, userId: user.id, pref: agentPrefFor(choice),
    }).catch((err) => ({ ok: false, error: err.message }));
    if (switched.ok) {
      change = (await loadActiveChange(pool, { agentSessionId, userId: user.id })) || change;
    } else {
      log.warn('agent-mayor', 'Could not switch the change to the conversation\'s model', {
        agentSessionId, changeId, err: switched.error,
      });
      return refusal('model_switch_failed: Could not switch to the selected model. No new coding run was started. Try again.');
    }
  }
  if (await shouldStop()) return stoppedBeforeStart();
  const release = d.activeWorkers.beginSessionOperation(changeId);
  // #937: a new dispatch is the boundary that retires the previous turn's
  // pending stop, exactly as a new classic turn is.
  d.worker.clearPendingStop(changeId);

  let seq = 0;
  const seqPrefix = `${Date.now().toString(36)}c${changeId}`;
  // One event, on every channel that watches a change: the conversation's
  // stream, the change's bus key and the global WebSocket. The change's own
  // end-of-run events stay on the change's channels: the conversation's turn
  // announces its own stop and its own end.
  const send = (type, data = {}) => {
    const event = { type, _seq: `${seqPrefix}-${++seq}`, ...data };
    if (!CHANGE_ONLY.has(type)) sendAgent(type, { ...data, changeId });
    if (!SSE_ONLY.has(type)) {
      try {
        d.broadcastGlobal({ ...event, sessionId: changeId, event: type, type: 'session_event' });
      } catch { /* best effort */ }
    }
    d.sessionBus.publish(changeId, event);
  };
  const sendStatus = async (text, metadata) => {
    send('status', { text, ...(metadata || {}) });
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [changeId, text, JSON.stringify(metadata || {})]
    ).catch(() => {});
  };
  const stopHandle = d.stopRegistry.createHandle({ sessionId: changeId, phase: 'cc', send });
  d.stopRegistry.set(changeId, stopHandle);
  onStopHandle({ changeId, handle: stopHandle });

  const heartbeatRes = {
    write: (chunk) => { try { if (res && typeof res.write === 'function') res.write(chunk); } catch { /* gone */ } },
  };
  let attachmentsBlock = '';
  if (Array.isArray(attachmentIds) && attachmentIds.length) {
    try {
      attachmentsBlock = d.attachments.buildDispatchBlock(await d.attachments.loadByIds(pool, attachmentIds));
    } catch (err) {
      log.warn('agent-dispatch', 'Attachments could not be read for the build', { agentSessionId, err: err.message });
    }
  }
  const args = {
    pool,
    config,
    req: { user },
    res: heartbeatRes,
    session: change,
    selectedModel: codingModelFor(change, d, choice),
    userMessage: userMessage || prompt,
    toolPromptArg: prompt || userMessage,
    attachmentsBlock,
    discussionBlock: '',
    repoOwner,
    repoName,
    send,
    sendStatus,
    stopHandle,
    userApiKey: apiKey,
    deferTurnCleanup: true,
  };

  const releaseAll = () => {
    release();
    d.stopRegistry.deleteIf(changeId, stopHandle);
  };
  // Release the durable turn record. Before that, the wrap-up is marked
  // posted so a recovery racing this cannot write a second one.
  const finishDurableTurn = async (turnId, { wrapUpPosted }) => {
    if (!turnId) return;
    if (wrapUpPosted) {
      await d.worker.noteTailMilestone(changeId, { wrapUpPosted: true }, { turnId }).catch(() => {});
    }
    const cleared = await d.worker.finishTurn(changeId, { turnId }).catch(() => false);
    if (!cleared) {
      log.warn('agent-mayor', 'Dispatch cleanup remains pending', { changeId, turnId });
      await turnDeps.scheduleRetainedInteractiveTurn({
        pool, sessionId: changeId, scheduleInteractiveRecovery, assumeRetained: true,
      });
    }
  };

  let result;
  try {
    if (await shouldStop()) stopHandle.stopped = true;
    result = stopHandle.stopped ? null : kind === 'scout'
      ? await turnDeps.runScoutTool(args)
      : await turnDeps.runClaudeCodeTool(args);
  } catch (err) {
    log.error('agent-mayor', 'Dispatch failed', { agentSessionId, changeId, err: err.message });
    releaseAll();
    await turnDeps.scheduleRetainedInteractiveTurn({ pool, sessionId: changeId, scheduleInteractiveRecovery })
      .catch(() => {});
    send('done', {});
    return {
      ran: true, changeId, kind, isError: true, stopped: false,
      toolResultText: 'failed: the coding agent could not finish this run. The platform recovers what it can.',
      finish: async () => {},
    };
  }

  if (stopHandle.stopped) {
    await finishDurableTurn(result && result.turnId, { wrapUpPosted: false });
    releaseAll();
    send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
    send('done', {});
    return {
      ran: true, changeId, kind, isError: false, stopped: true, stoppedBy: stopHandle.stoppedBy,
      toolResultText: 'stopped: the user stopped the coding agent.',
      finish: async () => {},
    };
  }

  let finished = false;
  return {
    ran: true,
    changeId,
    kind,
    isError: !!(result && result.isError),
    stopped: false,
    toolResultText: String((result && result.toolResultText) || ''),
    stagingUrl: (result && result.stagingUrl) || null,
    turnId: (result && result.turnId) || null,
    finish: async ({ wrapUpPosted = true } = {}) => {
      if (finished) return;
      finished = true;
      try {
        await finishDurableTurn(result && result.turnId, { wrapUpPosted });
      } finally {
        releaseAll();
        send('done', {});
      }
    },
  };
}

module.exports = {
  DISPATCH_KINDS,
  SCOUT_TOOL,
  BUILD_TOOL,
  isDispatchTool,
  loadActiveChange,
  canDispatch,
  resumeChange,
  codingModelFor,
  needsAgentSwitch,
  agentPrefFor,
  runDispatch,
};
