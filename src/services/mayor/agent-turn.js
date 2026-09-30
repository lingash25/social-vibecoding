'use strict';

// One Mayor turn in an agent session (#2779, spec: docs/agent-sessions.md,
// "The Mayor").
//
// The classic turn (./turn.js) is built around one change: its spec, its
// worker, its pull request, the per-change dispatch tail and its recovery.
// An agent session's turn is built around the conversation instead, and it
// is kept a separate module on purpose: classic sessions keep running the code
// that the golden tests pin byte for byte, and nothing here can change how
// they behave.
//
// Shape of a turn:
//
//   1. The user's message is recorded, on the active change's slice when
//      there is one, and on the conversation in every case. A follow-up turn
//      (after the user pressed Confirm on a card) records nothing: the card's
//      outcome is already in the conversation.
//   2. The Mayor runs a bounded tool loop. Its tools are the platform MCP
//      (reads run at once), its own moves (switch_active_change,
//      set_focus_app), web_fetch, reply suggestions, get_prod_status for an
//      admin on a platform change, and the two dispatches when the active
//      change can take one.
//   3. A tool that changes something never runs from the model. It becomes a
//      sealed confirmation card (services/agent-session-actions.js), and the
//      model is told nothing happened yet. recheck_change is the one
//      exception: it re-runs checks on a commit already there, moves no code
//      and clears no vote, so it runs at once with a one-action write grant.
//   4. The reply so far is recorded. A dispatch then runs the coding agent on
//      the active change (./agent-dispatch.js), and the Mayor writes a short
//      wrap-up from its result. The wrap-up cannot be stopped, as in a classic
//      session.
//   5. Spend is billed as Mayor calls as it happens; the coding agent's own
//      spend is recorded by the change's tools, as it always is.
//   6. When the replayed history has grown past its budget, the oldest turns
//      are summarized after the turn ends (./agent-compaction.js).
//
// Transport: every event is written to the turn's own SSE response and
// published on the conversation's bus (`agent:<id>`), so a client whose POST
// stream drops can resume through GET /api/agent-sessions/:id/events. The
// Mayor's own words are never broadcast on the global WebSocket: the
// conversation is private to its owner. A dispatch's events also reach the
// change's own channels, as any build's do.

const crypto = require('node:crypto');
const log = require('../logger');

const MAX_TOOL_ROUNDS = 6;
// A safety bound on what one turn replays. Compaction keeps the replayed
// history well under it in practice.
const HISTORY_ROWS = 400;
const TITLE_MAX = 80;
const LEASE_RENEW_MS = 15_000;
const EMPTY_REPLY_TEXT = 'I could not put an answer together that time. Could you say that again?';
// What the conversation says about a turn that ended with its process: a
// deploy replacing the platform's pod, or a crash. The screen offers Retry.
const INTERRUPTED_TEXT = 'The Mayor was interrupted by a platform update before it finished. Retry to pick it up again.';
// What the model is told on Retry: its last attempt at this turn left no
// answer, and the user asked for one.
const RETRY_NOTE = '[HOMEROOM] Your last answer to this was cut off by a platform restart before it finished, and '
  + 'the user pressed Retry. Answer their last message now. Do not mention the restart unless it matters.';

// The wrap-up is offered no tool but suggest_replies, so it cannot act on a
// dispatch that failed. Without this it has promised "Retrying now."
const WRAP_UP_NOTE = 'THIS REPLY\nYou are writing the wrap-up for the dispatch above. You cannot call any tool here '
  + 'except suggest_replies, so you cannot retry, dispatch or start anything in this reply. If the run did not start '
  + 'or did not finish, say so plainly and say what the user can do next, such as asking you to try again.';

// A reply that says the coding agent is starting. Questions and offers ("Want
// me to build it?") do not count; the check reads each sentence on its own.
const DISPATCH_CLAIM = /\b(?:(?:i'll|i will|i'm going to|i am going to|let me)\s+(?:dispatch|re-dispatch|start|launch|kick off|retry|send|hand)|dispatching|re-dispatching|starting|launching|kicking off|retrying|sending|handing)\b[^.!?\n]{0,60}\b(?:coding agent|scout)\b/i;

function claimsDispatch(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => !sentence.trim().endsWith('?') && DISPATCH_CLAIM.test(sentence));
}

function dispatchClaimNote(dispatchable) {
  return dispatchable
    ? '[HOMEROOM] Your reply says the coding agent is starting, but you did not call dispatch_coding_agent or '
      + 'dispatch_scout, so nothing is running. If the user asked for this work, call the tool now. Otherwise, tell '
      + 'the user in one sentence that nothing has started.'
    : '[HOMEROOM] Your reply says the coding agent is starting, but no dispatch is available on this turn (the '
      + 'active change cannot take one right now), so nothing is running. Tell the user in one sentence that '
      + 'nothing has started.';
}

const IMMEDIATE_WRITE_TOOLS = new Set(['recheck_change']);
const SUGGEST_REPLIES = 'suggest_replies';
const WEB_FETCH = 'web_fetch';
const GET_PROD_STATUS = 'get_prod_status';

const SWITCH_ACTIVE_CHANGE_TOOL = Object.freeze({
  name: 'switch_active_change',
  description: 'Make one of this conversation\'s earlier changes the active change again; the current one keeps its progress. '
    + 'Only changes this conversation started, and only ones still open. Use it when the user wants to go back to '
    + 'earlier work ("the dark-mode one").',
  input_schema: {
    type: 'object',
    properties: {
      changeId: { type: 'integer', description: 'The change id, from the CHANGES list or get_change.' },
    },
    required: ['changeId'],
  },
});

const SET_FOCUS_APP_TOOL = Object.freeze({
  name: 'set_focus_app',
  description: 'Record which app the user means when they do not name one. It changes nothing on the app; it is '
    + 'the default this conversation uses from now on.',
  input_schema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'The app slug, as list_apps returns it.' },
    },
    required: ['slug'],
  },
});

// Stop handles for the turns this process is running, by agent session id.
const stopRegistry = new Map();

function busKey(agentSessionId) {
  return `agent:${agentSessionId}`;
}

function defaults(deps = {}) {
  return {
    llm: deps.llm || require('../llm'),
    models: deps.models || require('../models'),
    limits: deps.limits || require('../limits'),
    openrouterMayor: deps.openrouterMayor || require('../openrouter-mayor'),
    openMayorMcp: deps.openMayorMcp || require('./mcp-shim').openMayorMcp,
    agentSessions: deps.agentSessions || require('../agent-sessions'),
    actions: deps.actions || require('../agent-session-actions'),
    sessionBus: deps.sessionBus || require('../session-bus'),
    getAgentMayorPrompt: deps.getAgentMayorPrompt || require('./agent-prompt').getAgentMayorPrompt,
    buildMayorMessages: deps.buildMayorMessages || require('./messages').buildMayorMessages,
    attachments: deps.attachments || require('../attachments'),
    stripFakeCompletionMarker: deps.stripFakeCompletionMarker || require('./messages').stripFakeCompletionMarker,
    dispatch: deps.dispatch || require('./agent-dispatch'),
    dispatchDeps: deps.dispatchDeps || {},
    compaction: deps.compaction || require('./agent-compaction'),
    tools: deps.tools || require('./tools'),
    dataTools: deps.dataTools || require('./data-tools'),
    debugAccess: deps.debugAccess || require('../debug-access'),
    // The dev chat's own "Session finished" (routes/sessions.js), read at
    // call time: that module requires this one at load.
    notifyDone: deps.notifyDone || ((pool, changeId) => require('../../routes/sessions').notifySessionDone(pool, changeId)),
    // The owner's lists (Recents, the mark's menu, Messages) show a spinner
    // while a turn runs and a dot once it has finished: tell every tab, on
    // every pod, when either happens.
    notifyUser: deps.notifyUser || ((userId, payload) => require('../ws').pushToUser(userId, payload)),
    isChangeBusy: deps.isChangeBusy || ((changeId) => require('../active-workers').isSessionBusy(changeId)),
    activeTurnMode: deps.activeTurnMode || ((changeId) => require('../worker').getActiveTurnMode(changeId)),
  };
}

// ── Who runs the Mayor, and who pays ───────────────────────────────────
//
// The same rules as a classic session's Mayor, keyed on the conversation's
// model choice (the composer's picker) and, when it has none, on the user's
// default coding backend: an OpenRouter choice runs the Mayor on that
// OpenRouter model and key (and an included key is gated on, and billed to,
// the shared weekly pool); a Claude one runs it on Anthropic, on the chosen
// model, through the limit-first platform or BYOK path. Read when a turn
// starts, so a pick made mid-turn applies from the next one.
async function resolveAgentMayor({ pool, config, userId, agentSessionId, requestedModel, deps = {} }) {
  const d = defaults(deps);
  const choice = await d.agentSessions.getAgentChoice(pool, agentSessionId);
  let pref;
  if (choice) {
    pref = { backend: choice.backend, model_id: choice.model };
  } else {
    const { rows } = await pool.query(
      `SELECT backend, model_id FROM user_agent_preferences
        WHERE user_id = $1 AND is_default = TRUE`,
      [userId]
    );
    pref = rows[0];
  }
  if (pref && pref.backend === 'codex_openrouter') {
    const resolved = await d.openrouterMayor.resolveForSession({
      pool,
      config,
      session: { id: null, agent_model: pref.model_id },
      userId,
      sessionKey: `homeroom-agent-${agentSessionId}`,
    });
    if (resolved.error) {
      return {
        ok: false, status: 503, code: 'mayor_unavailable',
        error: `Your OpenRouter setup cannot run the Mayor (${resolved.error}). Check your coding agent in Settings.`,
      };
    }
    if (resolved.usesIncludedKey) {
      const budget = await d.limits.checkBudget(pool, userId);
      if (budget.error) {
        return {
          ok: false, status: 429, code: 'budget_exceeded', error: budget.error,
          reason: budget.reason || null, verificationRequired: !!budget.verificationRequired,
        };
      }
    }
    return {
      ok: true,
      provider: 'openrouter',
      client: resolved.client,
      model: resolved.modelLabel,
      apiKey: null,
      spendRecorded: !!resolved.usesIncludedKey,
      byok: false,
    };
  }
  if (!d.llm.isEnabled()) return { ok: false, status: 503, code: 'llm_not_configured', error: 'LLM not configured' };
  const billing = await d.limits.resolveBillingPath(pool, config.dataEncryptionKey, userId);
  if (billing.error) {
    return {
      ok: false, status: 429, code: 'budget_exceeded', error: billing.error,
      reason: billing.reason || null, verificationRequired: !!billing.verificationRequired,
    };
  }
  // A model named on the request still wins (the turn route accepts one);
  // otherwise the conversation's Claude choice, otherwise the default.
  const claudeModel = requestedModel || (choice && choice.backend === 'claude_code' ? choice.model : null);
  return {
    ok: true,
    provider: 'anthropic',
    client: d.llm,
    model: d.models.resolve(claudeModel),
    apiKey: billing.apiKey || null,
    spendRecorded: true,
    byok: !!billing.apiKey,
  };
}

// The payer for a later call in the same turn (the wrap-up after a
// dispatch, a compaction): the dispatch may have used the last platform cent,
// or the user may have removed their key while it ran. Null when nobody can
// pay; the caller then falls back to fixed text.
async function rebillMayor({ pool, config, userId, mayor, d }) {
  if (mayor.provider !== 'anthropic') {
    if (mayor.spendRecorded) {
      const budget = await d.limits.checkBudget(pool, userId);
      if (budget.error) return null;
    }
    return { apiKey: null, byok: false };
  }
  const billing = await d.limits.resolveBillingPath(pool, config.dataEncryptionKey, userId);
  if (billing.error) return null;
  return { apiKey: billing.apiKey || null, byok: !!billing.apiKey };
}

// ── History ────────────────────────────────────────────────────────────

// The rows a turn replays: those after the summary, if there is one.
async function loadHistory(pool, agentSessionId, afterId = 0) {
  const { rows } = await pool.query(
    `SELECT id, session_id, role, content, metadata
       FROM chat_session_messages
      WHERE agent_session_id = $1 AND id > $3
        AND (role IN ('user', 'assistant')
             OR (role = 'system' AND (metadata->>'agentSessionEvent' IS NOT NULL
                                      OR metadata->>'ccOutput' IS NOT NULL)))
      ORDER BY id DESC
      LIMIT $2`,
    [agentSessionId, HISTORY_ROWS, Number(afterId) || 0]
  );
  return rows.reverse();
}

async function loadSummary(pool, agentSessionId) {
  const { rows } = await pool.query(
    'SELECT summary_md, summary_through_id FROM agent_sessions WHERE id = $1',
    [agentSessionId]
  );
  return rows[0]
    ? { text: rows[0].summary_md || null, throughId: rows[0].summary_through_id || 0 }
    : { text: null, throughId: 0 };
}

// The conversation as the model reads it. What the platform did between
// turns — a change started, a card confirmed or dismissed, a change merged —
// is folded in as a labelled note on the Mayor's side, so it can say what
// happened without having been asked. A coding agent's result is labelled
// with the change it ran on, because one conversation spans several. The
// history must open with the user.
function historyToMessages(rows, buildMayorMessages, attachmentsByMessageId = new Map()) {
  const mapped = rows.map((row) => {
    const metadata = row.metadata || {};
    if (row.role === 'system' && metadata.agentSessionEvent) {
      return { ...row, role: 'assistant', content: `[HOMEROOM] ${row.content}`, metadata: {} };
    }
    if (row.role === 'system' && metadata.ccOutput && row.session_id) {
      return { ...row, metadata: { ...metadata, ccOutput: `(change ${row.session_id}) ${metadata.ccOutput}` } };
    }
    return row;
  });
  // Files the user attached come back as the dev chat's Mayor reads them
  // (messages.js / attachments.js): recent images as vision blocks, text
  // files inlined, the rest named.
  const messages = buildMayorMessages(mapped, attachmentsByMessageId);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

// A follow-up turn has no user message of its own; the model is asked to
// carry on from the card's outcome, which history already holds.
function followUpNote(followUp) {
  const what = followUp && followUp.title ? `"${followUp.title}"` : 'a card';
  const how = followUp && followUp.ok === false ? 'it did not go through' : 'it went through';
  return `[HOMEROOM] The user pressed Confirm on ${what}, and ${how}. Carry on from here: say in one or two `
    + 'short sentences what happened. If the user had already asked for work that this unblocks (for example, '
    + 'building the change that was just started), do it now.';
}

function withTrailingUserText(messages, text) {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    return [...messages.slice(0, -1), { role: 'user', content: `${last.content}\n\n${text}` }];
  }
  // A user message with files is a list of blocks: the note joins it as one
  // more, rather than following it as a second user message in a row.
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    return [...messages.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text }] }];
  }
  return [...messages, { role: 'user', content: text }];
}

// The files the coding agent is handed: the ones sent with this turn's
// message, or on a follow-up turn (which has none), the latest message's.
function dispatchAttachmentIds(rows, attachments) {
  if (Array.isArray(attachments) && attachments.length) return attachments.map((att) => att.id);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role !== 'user') continue;
    const listed = rows[i].metadata && Array.isArray(rows[i].metadata.attachments) ? rows[i].metadata.attachments : [];
    return listed.map((att) => att && att.id).filter((attId) => typeof attId === 'string');
  }
  return [];
}

function lastUserText(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === 'user' && rows[i].content) return String(rows[i].content);
  }
  return '';
}

function titleFromMessage(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function costOf(mayor, result, d) {
  if (!result || !result.usage) return 0;
  const served = result.servedModel || mayor.model;
  try {
    return mayor.provider === 'anthropic'
      ? d.llm.estimateCostCents(result.usage, served)
      : mayor.client.estimateCostCents(result.usage, served);
  } catch {
    return 0;
  }
}

// What the conversation says when a wrap-up cannot be written by the model.
function fallbackWrapUp(outcome) {
  if (!outcome.ran) {
    const reason = String(outcome.toolResultText || '').replace(/^[a-z_]+:\s*/, '');
    return reason || 'The coding agent could not run on this change.';
  }
  if (outcome.isError) return 'The coding agent did not finish this run. The details are above.';
  if (outcome.kind === 'scout') return 'The spec is updated. Tell me when you want it built.';
  return 'The coding agent has finished. The details are above.';
}

// ── The turn ───────────────────────────────────────────────────────────

async function runAgentTurn({
  pool,
  config,
  user,
  agentSessionId,
  turnId,
  messageText = null,
  // The files sent with messageText, already checked as this user's own,
  // unsent uploads to this conversation (routes/agent-sessions.js).
  attachments = [],
  // The user's row when the route already wrote it with the lease
  // (agentSessions.startTurnWithMessage): `{ id, clientMessageId }`. The turn
  // then writes no row of its own and starts by saying it has the message.
  recorded = null,
  // Retry of a turn that did not finish: no new message, the model is told
  // to answer the last one.
  retry = false,
  followUp = null,
  mayor,
  res,
  scheduleInteractiveRecovery = null,
  deps = {},
}) {
  const d = defaults(deps);
  const listChanged = (busy) => {
    try { d.notifyUser(user.id, { type: 'agent_session_changed', agentSessionId, busy }); } catch { /* the lists catch up on their next read */ }
  };
  listChanged(true);
  const seqPrefix = String(turnId).slice(0, 8);
  let eventSeq = 0;
  const send = (type, data = {}) => {
    const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, agentSessionId, ...data };
    try { if (res) res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* the client left; the bus still has it */ }
    d.sessionBus.publish(busKey(agentSessionId), event);
  };
  const stop = {
    abort: new AbortController(), stopped: false, stoppedBy: null, send, phase: 'mayor', change: null,
    startedAt: Date.now(), buildStartedAt: null, turnId,
    // Set when this process is shutting down (interruptLocalTurns): the turn
    // ends as interrupted, with Retry, not as failed.
    interrupted: false,
    ended: null,
  };
  let markEnded = () => {};
  stop.ended = new Promise((resolve) => { markEnded = resolve; });
  const prior = stopRegistry.get(agentSessionId);
  if (prior && prior !== stop) { try { prior.abort.abort(); } catch { /* already gone */ } }
  stopRegistry.set(agentSessionId, stop);
  // The build's clock starts at the dispatch, so a screen that opens or
  // reconnects mid-build counts from there, not from when it arrived.
  const setPhase = (phase, extra = {}) => {
    stop.phase = phase;
    if (phase === 'cc') stop.buildStartedAt = Date.now();
    send('phase', { phase, ...(phase === 'cc' ? { startedAt: stop.buildStartedAt } : {}), ...extra });
    // On the lease too, so a screen that did not hear this event (another
    // pod, one opened mid-turn) reads where the turn is. Best effort: the
    // event already said it to the screens following this turn.
    if (typeof d.agentSessions.setTurnPhase === 'function') {
      Promise.resolve(d.agentSessions.setTurnPhase(pool, {
        agentSessionId, turnId, phase, startedAt: phase === 'cc' ? stop.buildStartedAt : null,
      })).catch(() => {});
    }
  };

  // The turn keeps its lease fresh while it runs: a dispatch can outlast the
  // stale window, and only a turn whose process died should lose it.
  const leaseTimer = setInterval(() => {
    d.agentSessions.renewTurnLease(pool, { agentSessionId, turnId }).catch(() => {});
    if (!stop.stopped && typeof d.agentSessions.readTurnStopRequest === 'function') {
      d.agentSessions.readTurnStopRequest(pool, { agentSessionId, turnId }).then((request) => {
        if (!request || stopRegistry.get(agentSessionId) !== stop) return;
        return require('../agent-session-stop').requestStop({ pool, user, agentSessionId, scheduleInteractiveRecovery });
      }).catch((err) => log.warn('agent-mayor', 'Could not apply durable stop', { agentSessionId, err: err.message }));
    }
  }, LEASE_RENEW_MS);
  if (typeof leaseTimer.unref === 'function') leaseTimer.unref();

  let shim = null;
  let unbilled = 0;
  let phaseOneCost = 0;
  let totalCost = 0;
  let visibleText = '';
  // What the current model call has streamed so far. A stop that aborts the
  // call mid-stream keeps it, because the user has already read it.
  let roundText = '';
  let persisted = false;
  let quickReplies = null;
  let compactionPlan = null;
  let summary = { text: null, throughId: 0 };
  let failed = false;
  const cards = [];
  const toolLog = [];

  const recordSpend = async (cents, byok = mayor.byok) => {
    if (!(cents > 0) || !mayor.spendRecorded) return;
    await d.limits.recordSpend(pool, user.id, cents, { byok: !!byok }).catch((err) => {
      log.warn('agent-mayor', 'Could not record Mayor spend', { agentSessionId, err: err.message });
    });
  };
  const bill = (cents) => {
    if (!(cents > 0)) return;
    unbilled += cents;
    totalCost += cents;
  };
  const flushSpend = async (byok) => {
    const cents = unbilled;
    unbilled = 0;
    await recordSpend(cents, byok);
  };

  const insertAssistant = async ({ text, cost, metadata, changeId }) => {
    // An OpenRouter Mayor's figure is the list-price estimate, never a
    // provider-reported amount, and the reply's cost label says so (#2118).
    const estimated = mayor.provider === 'openrouter' && cost > 0 ? { costEstimated: true } : {};
    const { rows } = await pool.query(
      `INSERT INTO chat_session_messages
         (session_id, agent_session_id, role, content, model, cost_cents, metadata)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [changeId || null, agentSessionId, text, mayor.model, cost, JSON.stringify({ ...metadata, ...estimated })]
    );
    return rows[0].id;
  };

  // The Mayor's reply before any dispatch, its cards and what its tools did,
  // as one assistant row. Written once, whether the turn went on to dispatch,
  // was stopped or failed part way, so a card the user can still press is
  // never missing from the transcript.
  const persistReply = async (flags = {}) => {
    if (persisted || (!visibleText && !cards.length)) return null;
    persisted = true;
    const after = await d.agentSessions.getAgentSession(pool, { userId: user.id, id: agentSessionId });
    return insertAssistant({
      text: visibleText,
      cost: phaseOneCost,
      changeId: after && after.activeChange ? after.activeChange.id : null,
      metadata: {
        agentTurnId: turnId,
        ...(cards.length ? { confirmations: cards } : {}),
        ...(toolLog.length ? { tools: toolLog } : {}),
        ...(quickReplies && !flags.dispatch ? { quickReplies } : {}),
        ...flags,
      },
    });
  };

  const keepStreamedText = () => {
    const partial = d.stripFakeCompletionMarker(roundText).trim();
    roundText = '';
    if (partial) visibleText = visibleText ? `${visibleText}\n\n${partial}` : partial;
  };

  // What the model may call this round. The dispatches and get_prod_status
  // depend on the active change, which a tool in an earlier round can move.
  const toolOffer = async () => {
    const change = await d.dispatch.loadActiveChange(pool, { agentSessionId, userId: user.id });
    const dispatchable = d.dispatch.canDispatch(change, d.dispatchDeps);
    let prodEligible = false;
    if (change) {
      try { prodEligible = await d.debugAccess.isEligible(pool, change.id); } catch { prodEligible = false; }
    }
    const tools = [
      ...shim.modelTools,
      SWITCH_ACTIVE_CHANGE_TOOL,
      SET_FOCUS_APP_TOOL,
      d.tools.WEB_FETCH_TOOL,
      d.tools.SUGGEST_REPLIES_TOOL,
      ...(dispatchable ? [d.dispatch.SCOUT_TOOL, d.dispatch.BUILD_TOOL] : []),
      ...(prodEligible ? [d.tools.GET_PROD_STATUS_TOOL] : []),
    ];
    return { tools, change, dispatchable, prodEligible };
  };

  // One tool call from the model, answered with the text the model reads.
  const resolveTool = async (use, offer) => {
    const input = use.input && typeof use.input === 'object' ? use.input : {};
    try {
      if (use.name === SWITCH_ACTIVE_CHANGE_TOOL.name) {
        const switched = await d.agentSessions.switchActiveChange(pool, {
          agentSessionId, userId: user.id, changeId: input.changeId,
        });
        send('active_change', { changeId: switched.change.id });
        return { ok: true, text: JSON.stringify({ ok: true, activeChangeId: switched.change.id, changed: switched.changed }) };
      }
      if (use.name === SET_FOCUS_APP_TOOL.name) {
        const app = await d.agentSessions.setFocusApp(pool, { agentSessionId, user, slug: input.slug });
        send('focus_app', { slug: app.slug });
        return { ok: true, text: JSON.stringify({ ok: true, focusApp: app.slug }) };
      }
      if (use.name === WEB_FETCH) {
        return { ok: true, text: await d.dataTools.resolveWebFetchToolResult(input.url) };
      }
      if (use.name === GET_PROD_STATUS) {
        if (!offer.prodEligible || !offer.change) return { ok: false, text: 'not_eligible' };
        return {
          ok: true,
          text: await d.dataTools.resolveProdStatusToolResult({ pool, config, sessionId: offer.change.id }),
        };
      }
      if (d.actions.isConfirmedTool(use.name)) {
        const card = await d.actions.prepareAction(pool, {
          config, userId: user.id, agentSessionId, toolName: use.name, input,
        });
        cards.push(card);
        send('confirmation_required', { card });
        // `input` is what the card will run, which is not always what the
        // model sent: a change started from the request the conversation was
        // opened on links that request (agent-session-actions.js).
        return {
          ok: true,
          text: JSON.stringify({
            status: 'pending_confirmation',
            actionId: card.id,
            input: card.input,
            note: 'Shown to the user as a confirmation card. Nothing has happened yet: it runs only if they press '
              + 'Confirm on the card. Tell them in one line what it will do.',
          }),
        };
      }
      if (IMMEDIATE_WRITE_TOOLS.has(use.name)) {
        const { READ_SCOPE, WRITE_SCOPE } = require('../mcp-connect-constants');
        const changeId = Number(input.changeId);
        const { rows } = await pool.query(
          'SELECT app_id FROM chat_sessions WHERE id = $1 AND user_id = $2',
          [Number.isSafeInteger(changeId) ? changeId : 0, user.id]
        );
        if (!rows.length) return { ok: false, text: 'no_access: that change is not one of the user\'s.' };
        const writer = await d.openMayorMcp({
          pool, config, userId: user.id, agentSessionId,
          scopes: [READ_SCOPE, WRITE_SCOPE], changeId, appId: rows[0].app_id, ttlSeconds: 60,
        });
        try {
          const result = await writer.call(use.name, input);
          return { ok: !result.isError, text: result.text };
        } finally {
          await writer.close('action_done');
        }
      }
      if (shim && shim.toolNames.includes(use.name)) {
        const result = await shim.call(use.name, input);
        return { ok: !result.isError, text: result.text };
      }
      return { ok: false, text: `unknown_tool: ${use.name} is not available in this conversation.` };
    } catch (err) {
      const message = err && typeof err.status === 'number' ? err.message : 'The tool could not run.';
      if (!(err && typeof err.status === 'number')) {
        log.warn('agent-mayor', 'Tool call failed', { agentSessionId, tool: use.name, err: err && err.message });
      }
      return { ok: false, text: `failed: ${message}` };
    }
  };

  // The dispatch, then the wrap-up. `dispatchUse` is the model's tool call;
  // `pendingResults` are that round's tool results, the dispatch's still
  // empty; `convo` ends with the assistant message that made the call.
  const runDispatchAndWrapUp = async ({ dispatchUse, pendingResults, convo, rows, systemPrompt }) => {
    const kind = d.dispatch.DISPATCH_KINDS[dispatchUse.name];
    const input = dispatchUse.input && typeof dispatchUse.input === 'object' ? dispatchUse.input : {};
    setPhase('cc', { kind });
    send('tool', { name: dispatchUse.name, state: 'running' });
    const outcome = await d.dispatch.runDispatch({
      pool,
      config,
      user,
      agentSessionId,
      kind,
      prompt: typeof input.prompt === 'string' ? input.prompt.trim() : '',
      userMessage: messageText || lastUserText(rows),
      attachmentIds: dispatchAttachmentIds(rows, messageText ? attachments : []),
      apiKey: mayor.apiKey,
      sendAgent: send,
      res,
      onStopHandle: (handle) => { stop.change = handle; },
      shouldStop: async () => stop.stopped || !!(typeof d.agentSessions.readTurnStopRequest === 'function'
        && await d.agentSessions.readTurnStopRequest(pool, { agentSessionId, turnId })),
      scheduleInteractiveRecovery,
      deps: d.dispatchDeps,
    });
    stop.change = null;
    const ok = outcome.ran && !outcome.isError && !outcome.stopped;
    toolLog.push({ name: dispatchUse.name, ok });
    send('tool', { name: dispatchUse.name, state: ok ? 'done' : 'failed' });
    if (outcome.stopped) {
      send('stopped', { phase: 'cc', by: outcome.stoppedBy || null });
      return;
    }
    // Whatever happens below, the change's operation and its durable turn
    // are released: the wrap-up is marked posted only once its row exists.
    let wrapUpPosted = false;
    try {
      wrapUpPosted = await writeWrapUp({ outcome, kind, dispatchUse, pendingResults, convo, systemPrompt });
    } finally {
      if (typeof outcome.finish === 'function') {
        await outcome.finish({ wrapUpPosted }).catch((err) => {
          log.warn('agent-mayor', 'Dispatch cleanup failed', { agentSessionId, err: err.message });
        });
      }
    }
    // A spec drafted or a build done while nobody is looking is the bell's,
    // as a dev chat's finished turn is ("Session finished", one unread per
    // change). Looking means this turn's own stream is still open, or the
    // conversation screen is following the conversation's events.
    if (outcome.ran && outcome.changeId && !watching()) {
      await d.notifyDone(pool, outcome.changeId);
    }
  };

  // Is anybody watching this conversation right now?
  const watching = () => {
    const streamOpen = !!res && !res.destroyed && !res.writableEnded
      && !(res.socket && res.socket.destroyed);
    const following = typeof d.sessionBus.subscriberCount === 'function'
      ? d.sessionBus.subscriberCount(busKey(agentSessionId)) > 0
      : false;
    return streamOpen || following;
  };

  // The wrap-up. It answers every tool call of the dispatching round, and it
  // cannot be stopped: the work it describes has already happened. Resolves
  // true once its row is written.
  const writeWrapUp = async ({ outcome, kind, dispatchUse, pendingResults, convo, systemPrompt }) => {
    setPhase('mayor2');
    const results = pendingResults.map((r) => (r.tool_use_id === dispatchUse.id
      ? {
        type: 'tool_result',
        tool_use_id: r.tool_use_id,
        content: outcome.toolResultText || '(no result)',
        ...(outcome.isError || !outcome.ran ? { is_error: true } : {}),
      }
      : r));
    let wrapText = '';
    let wrapReplies = null;
    let wrapCost = 0;
    let wrapByok = mayor.byok;
    try {
      const payer = await rebillMayor({ pool, config, userId: user.id, mayor, d });
      if (payer) {
        wrapByok = payer.byok;
        const session = await d.agentSessions.getAgentSession(pool, { userId: user.id, id: agentSessionId });
        const basePrompt = session
          ? d.getAgentMayorPrompt({ username: user.username, session, summary: summary.text })
          : systemPrompt;
        const wrap = await mayor.client.streamChat({
          messages: [...convo, { role: 'user', content: results }],
          systemPrompt: `${basePrompt}\n\n${WRAP_UP_NOTE}`,
          model: mayor.model,
          tools: [d.tools.SUGGEST_REPLIES_TOOL],
          onToken: (text) => send('token', { text }),
          apiKey: payer.apiKey,
          telemetryContext: {
            pool, appId: null, sessionId: outcome.changeId || null, backend: 'mayor', component: 'mayor_phase_2',
          },
        });
        wrapCost = costOf(mayor, wrap, d);
        bill(wrapCost);
        wrapText = d.stripFakeCompletionMarker(wrap.text || '').trim();
        const repliesUse = (wrap.toolUses || []).find((u) => u.name === SUGGEST_REPLIES);
        wrapReplies = repliesUse ? d.tools.sanitizeQuickReplies(repliesUse.input) : null;
      }
    } catch (err) {
      log.warn('agent-mayor', 'Wrap-up failed; using fixed text', { agentSessionId, err: err.message });
    }
    if (!wrapText) wrapText = fallbackWrapUp(outcome);
    const wrapId = await insertAssistant({
      text: wrapText,
      cost: wrapCost,
      changeId: outcome.changeId || null,
      metadata: {
        agentTurnId: turnId,
        wrapUp: true,
        dispatch: kind,
        ...(wrapReplies ? { quickReplies: wrapReplies } : {}),
      },
    });
    send('mayor_reasoning', { text: wrapText, messageId: wrapId, wrapUp: true });
    if (wrapReplies) send('quick_replies', { replies: wrapReplies });
    await flushSpend(wrapByok);
    return true;
  };

  try {
    const session = await d.agentSessions.getAgentSession(pool, { userId: user.id, id: agentSessionId });
    if (!session || session.status !== 'open') throw new Error('agent session is not open');

    if (recorded) {
      // Written with the lease, before the stream opened: say so first, so
      // the screen settles its "Sending" copy on this row.
      send('accepted', { messageId: recorded.id, clientMessageId: recorded.clientMessageId || null, turnId });
    } else if (retry) {
      send('accepted', { retry: true, turnId });
    } else if (messageText) {
      // A caller that has not written the row itself (the route writes it
      // with the lease, agentSessions.startTurnWithMessage) gets it written
      // here. The user's message: on the active change's slice when there is one,
      // so the change page reads the conversation that shaped it, and on the
      // conversation always.
      const { rows: inserted } = await pool.query(
        `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
         VALUES ($1, $2, 'user', $3, $4::jsonb)
         RETURNING id`,
        [session.activeChange ? session.activeChange.id : null, agentSessionId, messageText,
          JSON.stringify({ agentTurnId: turnId, ...(attachments.length ? { attachments } : {}) })]
      );
      // The files belong to this message now: out of the orphan sweep's
      // reach, and what the Mayor's history reads back.
      if (attachments.length && inserted && inserted[0]) {
        await pool.query(
          `UPDATE chat_session_attachments SET message_id = $1
            WHERE id = ANY($2) AND agent_session_id = $3 AND message_id IS NULL`,
          [inserted[0].id, attachments.map((att) => att.id), agentSessionId]
        );
      }
      if (!session.title) {
        await pool.query(
          `UPDATE agent_sessions SET title = $1
            WHERE id = $2 AND title IS NULL AND title_source = 'auto'`,
          [titleFromMessage(messageText), agentSessionId]
        );
      }
    }

    setPhase('mayor', followUp ? { followUp: true } : {});
    summary = await loadSummary(pool, agentSessionId);
    const history = await loadHistory(pool, agentSessionId, summary.throughId);
    compactionPlan = d.compaction.planCompaction(history);
    const historyAttachments = await d.attachments.loadForHistory(pool, history);
    let convo = historyToMessages(history, d.buildMayorMessages, historyAttachments);
    if (retry) convo = withTrailingUserText(convo, RETRY_NOTE);
    else if (!messageText) convo = withTrailingUserText(convo, followUpNote(followUp));
    const systemPrompt = d.getAgentMayorPrompt({ username: user.username, session, summary: summary.text });
    shim = await d.openMayorMcp({ pool, config, userId: user.id, agentSessionId });

    let dispatchUse = null;
    let pendingResults = null;
    let claimChecked = false;
    for (let round = 0; ; round += 1) {
      const lastRound = round >= MAX_TOOL_ROUNDS;
      const offer = await toolOffer();
      roundText = '';
      const result = await mayor.client.streamChat({
        messages: convo,
        systemPrompt,
        model: mayor.model,
        tools: offer.tools,
        ...(lastRound ? { toolChoice: { type: 'none' } } : {}),
        signal: stop.abort.signal,
        onToken: (text) => { roundText += text; send('token', { text }); },
        apiKey: mayor.apiKey,
        telemetryContext: {
          pool, appId: null, sessionId: null, backend: 'mayor',
          component: round === 0 ? 'mayor_phase_1' : 'mayor_data_iteration',
        },
      });
      const cents = costOf(mayor, result, d);
      bill(cents);
      phaseOneCost += cents;
      roundText = '';
      const text = d.stripFakeCompletionMarker(result.text || '').trim();
      if (text) visibleText = visibleText ? `${visibleText}\n\n${text}` : text;
      const toolUses = Array.isArray(result.toolUses) ? result.toolUses : [];
      // The turn is ending without a dispatch. A reply that says one is
      // under way gets one more round to make the call or take it back. A
      // pending card is exempt: its dispatch follows the user's confirm.
      if (!toolUses.length && !stop.stopped && !lastRound && !claimChecked && !cards.length) {
        claimChecked = true;
        if (claimsDispatch(visibleText)) {
          const note = dispatchClaimNote(offer.dispatchable);
          // The claim can sit in an earlier round's text, with this round's
          // reply empty; an empty assistant message is not replayable.
          convo = text
            ? [...convo, { role: 'assistant', content: [{ type: 'text', text }] }, { role: 'user', content: note }]
            : withTrailingUserText(convo, note);
          continue;
        }
      }
      if (stop.stopped || !toolUses.length || lastRound) break;

      convo = [...convo, { role: 'assistant', content: result.rawContent }];
      const dispatchCalls = toolUses.filter((use) => d.dispatch.isDispatchTool(use.name));
      const chosen = offer.dispatchable
        ? (dispatchCalls.find((use) => use.name === d.dispatch.SCOUT_TOOL.name) || dispatchCalls[0] || null)
        : null;
      const toolResults = [];
      for (const use of toolUses) {
        if (d.dispatch.isDispatchTool(use.name)) {
          if (use === chosen) {
            toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: '' });
            continue;
          }
          toolLog.push({ name: use.name, ok: false });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: offer.dispatchable
              ? 'skipped: only one dispatch runs per turn.'
              : 'not_available: there is no active change that can take a dispatch right now.',
            is_error: true,
          });
          continue;
        }
        if (use.name === SUGGEST_REPLIES) {
          quickReplies = d.tools.sanitizeQuickReplies(use.input) || quickReplies;
          toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'Shown to the user as reply buttons.' });
          continue;
        }
        send('tool', { name: use.name, state: 'running' });
        // eslint-disable-next-line no-await-in-loop
        const answer = await resolveTool(use, offer);
        toolLog.push({ name: use.name, ok: answer.ok });
        send('tool', { name: use.name, state: answer.ok ? 'done' : 'failed' });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: answer.text,
          ...(answer.ok ? {} : { is_error: true }),
        });
      }
      if (chosen && !stop.stopped) {
        dispatchUse = chosen;
        pendingResults = toolResults;
        break;
      }
      convo = [...convo, { role: 'user', content: toolResults }];
    }

    if (stop.stopped) send('stopped', { by: stop.stoppedBy });
    if (!visibleText && !cards.length && !stop.stopped && !dispatchUse) visibleText = EMPTY_REPLY_TEXT;

    const dispatchKind = dispatchUse ? d.dispatch.DISPATCH_KINDS[dispatchUse.name] : null;
    const messageId = await persistReply(stop.stopped ? { stopped: true } : (dispatchKind ? { dispatch: dispatchKind } : {}));
    if (messageId || cards.length) send('mayor_reasoning', { text: visibleText, messageId, cards });
    if (quickReplies && !dispatchUse) send('quick_replies', { replies: quickReplies });
    await flushSpend();

    if (dispatchUse && !stop.stopped) {
      await runDispatchAndWrapUp({ dispatchUse, pendingResults, convo, rows: history, systemPrompt });
    }
    send('usage', { costCents: totalCost });
  } catch (err) {
    failed = true;
    await flushSpend();
    if (stop.stopped || stop.interrupted) keepStreamedText();
    const flag = stop.stopped ? { stopped: true } : (stop.interrupted ? { interrupted: true } : { failed: true });
    const messageId = await persistReply(flag).catch((persistErr) => {
      log.warn('agent-mayor', 'Could not record a cut-short reply', { agentSessionId, err: persistErr.message });
      return null;
    });
    if (messageId) send('mayor_reasoning', { text: visibleText, messageId, cards });
    if (stop.stopped) {
      send('stopped', { by: stop.stoppedBy });
    } else if (stop.interrupted) {
      log.info('agent-mayor', 'Agent turn interrupted by shutdown', { agentSessionId });
      await d.agentSessions.appendConversationEvent(pool, {
        agentSessionId,
        content: INTERRUPTED_TEXT,
        event: 'turn_interrupted',
        metadata: { agentTurnId: turnId, retryable: true },
      }).catch(() => {});
    } else {
      log.error('agent-mayor', 'Agent turn failed', { agentSessionId, err: err.message });
      send('error', { error: 'The Mayor could not finish this turn. Try again.' });
      await d.agentSessions.appendConversationEvent(pool, {
        agentSessionId,
        content: 'The last turn did not finish.',
        event: 'turn_failed',
        metadata: { agentTurnId: turnId, retryable: true },
      }).catch(() => {});
    }
  } finally {
    clearInterval(leaseTimer);
    if (shim) await shim.close('turn_finished');
    if (stopRegistry.get(agentSessionId) === stop) stopRegistry.delete(agentSessionId);
    await d.agentSessions.releaseTurnLease(pool, { agentSessionId, turnId, finished: true }).catch((err) => {
      log.warn('agent-mayor', 'Could not release the turn lease', { agentSessionId, err: err.message });
    });
    listChanged(false);
    send('done', {});
    try { if (res) res.end(); } catch { /* already closed */ }
    markEnded();
    // The buffer lets a screen that reconnects moments later replay the end
    // of this turn. A turn that started since owns it now: clearing it would
    // throw that turn's first events away.
    setTimeout(() => {
      if (!stopRegistry.has(agentSessionId)) d.sessionBus.clearSession(busKey(agentSessionId));
    }, 30_000).unref?.();
  }

  // After the turn, and off its critical path: fold the oldest turns into
  // the summary when the replayed history has grown past its budget.
  if (compactionPlan && !failed) {
    await compactHistory({ pool, config, user, agentSessionId, mayor, summary, plan: compactionPlan, d });
  }
}

async function compactHistory({ pool, config, user, agentSessionId, mayor, summary, plan, d }) {
  try {
    const payer = await rebillMayor({ pool, config, userId: user.id, mayor, d });
    if (!payer) return;
    const cents = await d.compaction.compact({
      pool,
      agentSessionId,
      mayor: { ...mayor, apiKey: payer.apiKey },
      previousSummary: summary.text,
      plan,
      costOf: (result) => costOf(mayor, result, d),
    });
    if (cents > 0 && mayor.spendRecorded) {
      await d.limits.recordSpend(pool, user.id, cents, { byok: !!payer.byok });
    }
  } catch (err) {
    log.warn('agent-mayor', 'Compaction failed', { agentSessionId, err: err.message });
  }
}

// POST /stop. The Mayor's own phase is stopped here: the model call is
// aborted and the turn records what it had said, including what the aborted
// call had streamed, and any cards it prepared. A running dispatch is the
// change's: its stop goes through POST /api/sessions/:changeId/stop, which
// confirms the kill and escalates, so this answers with the change to stop.
// The wrap-up cannot be stopped.
function stopAgentTurn(agentSessionId, { by = null, expectedTurnId = null } = {}) {
  const handle = stopRegistry.get(agentSessionId);
  if (!handle) return { stopped: false, reason: 'no_active_turn' };
  if (expectedTurnId && handle.turnId !== expectedTurnId) return { stopped: false, reason: 'turn_changed' };
  if (handle.phase === 'mayor2') return { stopped: false, reason: 'wrap_up_not_stoppable' };
  if (handle.phase === 'cc') {
    handle.stopped = true;
    handle.stoppedBy = by;
    if (!handle.stopRequestedAt) handle.stopRequestedAt = Date.now();
    const child = handle.change?.handle;
    if (child && child.phase !== 'mayor2') {
      child.stopped = true;
      child.stoppedBy = by;
      child.stopRequestedAt ||= handle.stopRequestedAt;
      try { child.abort.abort(); } catch { /* already aborted */ }
    }
    return {
      stopped: false,
      reason: 'dispatch_running',
      changeId: handle.change ? handle.change.changeId : null,
    };
  }
  handle.stopped = true;
  handle.stoppedBy = by;
  if (!handle.stopRequestedAt) handle.stopRequestedAt = Date.now();
  try { handle.send('stopping', { by }); } catch { /* best effort */ }
  try { handle.abort.abort(); } catch { /* already aborted */ }
  return { stopped: true, phase: handle.phase };
}

// Cross-process notifications are a wake-up, never permission to stop an
// arbitrary run. Re-read the durable intent and match the exact local turn.
async function receiveStopRequest(pool, { agentSessionId, turnId } = {}, deps = {}) {
  const handle = stopRegistry.get(Number(agentSessionId));
  if (!pool || !handle || handle.turnId !== turnId) return false;
  const request = await (deps.agentSessions || require('../agent-sessions')).readTurnStopRequest(pool, { agentSessionId, turnId });
  if (!request || stopRegistry.get(Number(agentSessionId)) !== handle) return false;
  stopAgentTurn(Number(agentSessionId), { by: request.stopRequestedBy, expectedTurnId: turnId });
  return true;
}

// Where the running turn is, for a client that joins mid-turn.
function turnState(agentSessionId) {
  const handle = stopRegistry.get(agentSessionId);
  if (!handle) return null;
  return {
    id: handle.turnId || null,
    phase: handle.phase,
    stopping: !!handle.stopped,
    stopRequestedAt: handle.stopRequestedAt || null,
    changeId: handle.change ? handle.change.changeId : null,
    // What the screen's clock counts from: the build once one was
    // dispatched (the wrap-up keeps counting it), else the turn.
    startedAt: handle.buildStartedAt || handle.startedAt || null,
  };
}

// A build that restart recovery adopted runs on the conversation's active
// change with no Mayor turn behind it: the turn that dispatched it died with
// the old process. It is still the conversation's running work, so it reads
// as a running dispatch, and stop goes to the change.
function recoveredRunState(agentSessionId, changeId, deps = {}) {
  if (stopRegistry.has(agentSessionId) || !changeId) return null;
  const d = defaults(deps);
  if (!d.isChangeBusy(changeId)) return null;
  // The change's before/after shots are not the coding agent: the
  // conversation shows it as its own capture (activeChange.previewCapture).
  if (d.activeTurnMode(changeId) === 'shots') return null;
  return { phase: 'cc', stopping: false, changeId };
}

// A turn whose process died (a restart mid-dispatch) leaves its lease and
// its open screens behind: nothing will ever send their `done`. Once the
// lease is stale, clear it and send that `done` in the dead turn's place, so
// the screen settles on what the transcript holds. Never while this process
// runs a turn there. `finished` stamps the green dot: a recovery that posted
// the wrap-up finished the dead turn's work. True when it handed one back.
async function handBackOrphanedTurn({ pool, agentSessionId, userId, finished = false, deps = {} }) {
  if (stopRegistry.has(agentSessionId)) return false;
  const d = defaults(deps);
  const released = await d.agentSessions.releaseStaleTurnLease(pool, { agentSessionId, userId, finished });
  if (!released) return false;
  log.info('agent-mayor', 'Handed back an orphaned turn lease', { agentSessionId, finished });
  try { d.notifyUser(userId, { type: 'agent_session_changed', agentSessionId, busy: false }); } catch { /* the lists catch up on their next read */ }
  d.sessionBus.publish(busKey(agentSessionId), {
    type: 'done', _seq: `orphan-${Date.now().toString(36)}`, agentSessionId,
  });
  return true;
}

// A recovered run on `changeId` has ended, however it ended: hand back the
// dead dispatching turn of every conversation it is the active change of. A
// screen following the run settles now; a lease not yet stale (the restart
// was moments ago) is released once it is.
async function handBackAfterRecovery({ pool, changeId, deps = {}, retryMs = null }) {
  const d = defaults(deps);
  const conversations = await d.agentSessions.conversationsOfChange(pool, changeId);
  for (const { agentSessionId, userId } of conversations) {
    // eslint-disable-next-line no-await-in-loop
    const handed = await handBackOrphanedTurn({ pool, agentSessionId, userId, finished: true, deps });
    if (handed || stopRegistry.has(agentSessionId)) continue;
    try { d.notifyUser(userId, { type: 'agent_session_changed', agentSessionId, busy: false }); } catch { /* the lists catch up on their next read */ }
    d.sessionBus.publish(busKey(agentSessionId), {
      type: 'done', _seq: `recovered-${Date.now().toString(36)}`, agentSessionId,
    });
    const wait = retryMs ?? (d.agentSessions.TURN_LEASE_STALE_SECONDS * 1000 + LEASE_RENEW_MS);
    const timer = setTimeout(() => {
      handBackOrphanedTurn({ pool, agentSessionId, userId, finished: true, deps }).catch((err) => {
        log.warn('agent-mayor', 'Could not hand back an orphaned turn lease', { agentSessionId, err: err.message });
      });
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

// ── Turns that end with their process ──────────────────────────────────
//
// Every deploy replaces the platform's one pod, and the turns running in it
// end with it. Two things make sure a conversation is never left looking
// busy with nobody working, and never silently without its answer:

// 1. A process that is shutting down ends its own Mayor turns as
// interrupted: what was said so far is kept, the conversation says the turn
// was interrupted (with Retry), and the lease is handed back. A turn whose
// coding agent is running is left alone: the build belongs to the change,
// and restart recovery adopts it (handBackAfterRecovery). Resolves once each
// ended turn has written its end, or after `timeoutMs`.
async function interruptLocalTurns({ timeoutMs = 3000 } = {}) {
  const ending = [];
  for (const handle of stopRegistry.values()) {
    if (handle.phase === 'cc' || handle.stopped || handle.interrupted) continue;
    handle.interrupted = true;
    try { handle.abort.abort(); } catch { /* already aborted */ }
    if (handle.ended) ending.push(handle.ended);
  }
  if (!ending.length) return 0;
  let timer = null;
  await Promise.race([
    Promise.allSettled(ending),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return ending.length;
}

// 2. A process that died without that (a crash, a kill) leaves its leases to
// go stale. The sweeper, on every pod, ends each stale one as interrupted, in
// one transaction with the note (agentSessions.endInterruptedTurn), and the
// database's version bump tells every screen. A conversation whose active
// change still has a run on record is left to restart recovery, which hands
// it back when the build ends.
// `agentSessionId` sweeps that one conversation only: a read of it that
// found its lease stale ends the turn there and then (routes/agent-sessions.js
// GET /:id/state), rather than showing an idle conversation with no answer
// until the next sweep.
async function sweepInterruptedTurns({ pool, agentSessionId = null, deps = {} } = {}) {
  const d = defaults(deps);
  const stale = await d.agentSessions.staleTurnLeases(pool, agentSessionId == null ? {} : { agentSessionId });
  let ended = 0;
  for (const lease of stale) {
    if (stopRegistry.has(lease.agentSessionId)) continue;
    if (lease.changeTurn || recoveredRunState(lease.agentSessionId, lease.activeChangeId, deps)) continue;
    // eslint-disable-next-line no-await-in-loop
    const done = await d.agentSessions.endInterruptedTurn(pool, {
      agentSessionId: lease.agentSessionId, turnId: lease.turnId, content: INTERRUPTED_TEXT,
    }).catch((err) => {
      log.warn('agent-mayor', 'Could not end an interrupted turn', { agentSessionId: lease.agentSessionId, err: err.message });
      return false;
    });
    if (!done) continue;
    ended += 1;
    log.info('agent-mayor', 'Ended a turn its process left behind', { agentSessionId: lease.agentSessionId });
    try { d.notifyUser(lease.userId, { type: 'agent_session_changed', agentSessionId: lease.agentSessionId, busy: false }); } catch { /* the version notice says it too */ }
    d.sessionBus.publish(busKey(lease.agentSessionId), {
      type: 'done', _seq: `interrupted-${Date.now().toString(36)}`, agentSessionId: lease.agentSessionId,
    });
  }
  return ended;
}

const SWEEP_EVERY_MS = 30_000;
let sweepTimer = null;

// Started once per process, after boot (server.js). The first sweep waits a
// window, so a turn another pod is still finishing during a rollout has had
// every chance to renew.
function startInterruptedTurnSweeper({ pool, everyMs = SWEEP_EVERY_MS } = {}) {
  if (sweepTimer) return;
  const tick = () => {
    sweepInterruptedTurns({ pool }).catch((err) => {
      log.warn('agent-mayor', 'Interrupted-turn sweep failed', { err: err.message });
    });
  };
  sweepTimer = setInterval(tick, everyMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

function stopInterruptedTurnSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function newTurnId() {
  return crypto.randomUUID();
}

module.exports = {
  MAX_TOOL_ROUNDS,
  HISTORY_ROWS,
  LEASE_RENEW_MS,
  EMPTY_REPLY_TEXT,
  INTERRUPTED_TEXT,
  RETRY_NOTE,
  IMMEDIATE_WRITE_TOOLS,
  SWITCH_ACTIVE_CHANGE_TOOL,
  SET_FOCUS_APP_TOOL,
  busKey,
  resolveAgentMayor,
  rebillMayor,
  loadHistory,
  loadSummary,
  historyToMessages,
  withTrailingUserText,
  dispatchAttachmentIds,
  followUpNote,
  claimsDispatch,
  dispatchClaimNote,
  WRAP_UP_NOTE,
  titleFromMessage,
  fallbackWrapUp,
  runAgentTurn,
  stopAgentTurn, receiveStopRequest,
  turnState,
  handBackOrphanedTurn,
  handBackAfterRecovery,
  recoveredRunState,
  interruptLocalTurns,
  sweepInterruptedTurns,
  startInterruptedTurnSweeper,
  stopInterruptedTurnSweeper,
  newTurnId,
  _stopRegistry: stopRegistry,
};
