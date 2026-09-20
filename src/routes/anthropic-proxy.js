'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { anthropicProxyAuth } = require('../middleware/anthropic-proxy-auth');
const { getPool } = require('../db/pool');
const limits = require('../services/limits');
const anthropicStream = require('../services/anthropic-stream');
const budgetLive = require('../services/budget-live');
const log = require('../services/logger');

// Worker → platform Anthropic-proxy.
//
// Why this exists: the CC worker container runs `claude
// --dangerously-skip-permissions` against user prompts. If the worker
// holds the platform's real ANTHROPIC_API_KEY, any user can ask CC to
// `echo $ANTHROPIC_API_KEY` and exfiltrate the platform-wide key.
//
// Instead, the worker holds a session-scoped worker:anthropic-proxy token
// (in ANTHROPIC_API_KEY, picked up by the SDK as x-api-key) and points
// ANTHROPIC_BASE_URL at /api/internal/anthropic on the platform. This proxy
// verifies that narrow purpose, swaps the header for the real key, and
// forwards to api.anthropic.com. An exfiltrated proxy token cannot call the
// platform's push/draft APIs or Anthropic directly, and expires with the
// worker-token TTL.
//
// The proxy also enforces the daily LLM cap mid-stream:
//   1. Start-of-call gate. Cheap pre-check; if today's recorded spend
//      already meets the cap, return 429 immediately so we don't even
//      open a socket to Anthropic.
//   2. Mid-stream kill. As Anthropic's SSE response flows through, the
//      shared forward loop (services/anthropic-stream.js) tees each
//      chunk into a tiny SSE parser, computes a running cost, and
//      aborts the upstream socket the moment running_total + this
//      call's running cost would cross the user's effective cap. The
//      Anthropic SDK in the `claude` CLI sees the truncated stream as
//      a normal API error and the turn ends. Worst-case overshoot is
//      bounded to "what landed between two `message_delta` events" —
//      typically a few cents.
//
// The stream-forwarding mechanics (SSE tee, header filtering, the
// forward/kill loop) live in src/services/anthropic-stream.js, shared
// with the app-LLM proxy (routes/app-llm-proxy.js, issue #34). What
// stays here is worker-specific: session→user resolution, the user
// budget cache, and the gates.
//
// BYOK turns bypass the proxy entirely (worker.js sets the user's key
// directly in ANTHROPIC_API_KEY and leaves ANTHROPIC_BASE_URL unset),
// so this enforcement only applies to the platform-key code path.
//
// #664: for build/scout turns the payer is resolved PER CALL, mirroring
// the app-LLM proxy (routes/app-llm-proxy.js): while the daily allowance
// (user cap AND global cap) has headroom the platform key pays; the
// moment it's exhausted, calls from users with a BYOK key on file switch
// to that key mid-turn instead of erroring (the first switched call also
// posts a one-time in-chat notice). Keyless users keep the exact 429 /
// mid-stream-kill behaviour they had. Sync turns never spill onto a
// user's key — platform housekeeping bills the system budget only.

const ROUTE_PREFIX = '/api/internal/anthropic/';

// How long a per-user DB-spend snapshot is considered fresh. The cap
// itself comes from limits.js which has its own internal cache, so
// nothing here gates how often the cap is re-read — only the
// per-user `total_cost_cents` lookup is rate-limited by this TTL. A
// 10s window matches limits.js so admin cap changes propagate at the
// same speed as user-spend updates.
const BUDGET_CACHE_TTL_MS = 10_000;

// chat_sessions never change owners, so a per-process cache for the
// session→user lookup is safe forever. Cleared on process restart.
const sessionUserCache = new Map(); // sessionId -> userId

// Per-user spend tracker. `totalAtCheckpointCents` is the most recent
// `llm_usage.total_cost_cents` we read from the DB; `liveDeltaCents`
// is the sum of finalized Anthropic-call costs we've observed via the
// SSE tee since that checkpoint. On each refresh we re-read the DB
// and reset liveDeltaCents to 0 — once a CC turn ends, sessions.js
// writes the turn's full cost to llm_usage and the next refresh picks
// it up. There is a brief race window (turn-end write vs proxy
// refresh) where new costs aren't accounted for; bounded to
// BUDGET_CACHE_TTL_MS worth of generation, i.e. cents.
const userBudgetCache = new Map();
//   userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

// #361: process-local mirror of userBudgetCache for the system-token
// budget. Merge-conflict / sync turns bill this single daily bucket
// instead of any user, so there's one tracker (not keyed by user). Same
// checkpoint+liveDelta shape so the mid-stream kill works identically.
let systemBudgetCache = null; // { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function refreshSystemBudget(pool) {
  const now = Date.now();
  if (systemBudgetCache && now - systemBudgetCache.fetchedAt < BUDGET_CACHE_TTL_MS) {
    return systemBudgetCache;
  }
  try {
    const { rows } = await pool.query(
      'SELECT cost_cents FROM system_token_usage WHERE date = CURRENT_DATE'
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.cost_cents || 0);
    systemBudgetCache = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    return systemBudgetCache;
  } catch (err) {
    log.warn('anthropic-proxy', 'System budget refresh failed; failing open', { err: err.message });
    systemBudgetCache = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    return systemBudgetCache;
  }
}

async function resolveUserId(pool, sessionId) {
  if (sessionUserCache.has(sessionId)) return sessionUserCache.get(sessionId);
  try {
    const { rows } = await pool.query(
      'SELECT user_id FROM chat_sessions WHERE id = $1',
      [sessionId]
    );
    const userId = rows[0]?.user_id ?? null;
    // Don't cache the null result — the session might land in the DB a
    // moment later (e.g. row creation racing with the first proxy
    // call). Only memoize hits.
    if (userId) sessionUserCache.set(sessionId, userId);
    return userId;
  } catch (err) {
    log.warn('anthropic-proxy', 'Session lookup failed', { sessionId, err: err.message });
    return null;
  }
}

async function refreshUserBudget(pool, userId) {
  const cached = userBudgetCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached;
  try {
    const { rows } = await pool.query(
      'SELECT total_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE',
      [userId]
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.total_cost_cents || 0);
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  } catch (err) {
    log.warn('anthropic-proxy', 'Budget refresh failed; failing open', {
      userId, err: err.message,
    });
    // Fail open on a transient DB hiccup rather than blocking traffic.
    // The next refresh will catch up; bounded by TTL.
    const fresh = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    userBudgetCache.set(userId, fresh);
    return fresh;
  }
}

// #1788: process-local mirror of userBudgetCache for the WEEKLY per-user
// cap. Same checkpoint+liveDelta shape and the same fail-open posture as
// refreshUserBudget above — a bookkeeping read must never be what refuses
// a turn. Keyed by user; only populated when a weekly cap actually
// applies, so users with the weekly layer switched off pay nothing for it.
const weeklyBudgetCache = new Map();
//   userId -> { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function refreshUserWeeklySpend(pool, userId) {
  const cached = weeklyBudgetCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_cost_cents), 0) AS total
         FROM llm_usage
        WHERE user_id = $1 AND date >= $2`,
      [userId, limits.weekStartUtc()]
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.total || 0);
    const fresh = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    weeklyBudgetCache.set(userId, fresh);
    return fresh;
  } catch (err) {
    log.warn('anthropic-proxy', 'Weekly budget refresh failed; failing open', {
      userId, err: err.message,
    });
    const fresh = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    weeklyBudgetCache.set(userId, fresh);
    return fresh;
  }
}

// #1788: shown when BOTH caps are switched off for an account. Fails
// closed by design — an account with no allowance configured has nothing
// to draw from, so it is refused rather than granted the platform key.
const NO_ALLOWANCE_MESSAGE =
  'No AI allowance is configured for this account. An admin can set a daily or weekly cap in the admin console.';

// #664: process-local mirror of userBudgetCache for the GLOBAL daily cap
// (sum across every user's platform-billed spend today). One tracker, same
// checkpoint+liveDelta shape; platform-billed call costs fold into it at
// settlement alongside the per-user tracker so a mid-turn global-cap
// crossing is visible to the per-call payer decision.
let globalBudgetCache = null; // { totalAtCheckpointCents, fetchedAt, liveDeltaCents }

async function refreshGlobalSpend(pool) {
  const now = Date.now();
  if (globalBudgetCache && now - globalBudgetCache.fetchedAt < BUDGET_CACHE_TTL_MS) {
    return globalBudgetCache;
  }
  try {
    const { rows } = await pool.query(
      'SELECT SUM(total_cost_cents) as total FROM llm_usage WHERE date = CURRENT_DATE'
    );
    const totalAtCheckpointCents = parseFloat(rows[0]?.total || 0);
    globalBudgetCache = { totalAtCheckpointCents, fetchedAt: now, liveDeltaCents: 0 };
    return globalBudgetCache;
  } catch (err) {
    log.warn('anthropic-proxy', 'Global spend refresh failed; failing open', { err: err.message });
    globalBudgetCache = { totalAtCheckpointCents: 0, fetchedAt: now, liveDeltaCents: 0 };
    return globalBudgetCache;
  }
}

// #664: cheap cached "does this user have a BYOK key on file?" bit — an
// EXISTS query, no decryption. Used to suppress the mid-stream kill on
// the boundary call when a fallback exists (the NEXT call's gate does
// the actual switch). Fails closed (false → kill stays active, exactly
// today's behaviour) on a DB hiccup.
const byokPresenceCache = new Map(); // userId -> { present, fetchedAt }

async function hasByokKeyOnFile(pool, userId) {
  const cached = byokPresenceCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached.present;
  try {
    const { rows } = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND anthropic_key_enc IS NOT NULL) AS present',
      [userId]
    );
    const present = !!rows[0]?.present;
    byokPresenceCache.set(userId, { present, fetchedAt: now });
    return present;
  } catch (err) {
    log.warn('anthropic-proxy', 'BYOK key presence check failed; assuming none', {
      userId, err: err.message,
    });
    byokPresenceCache.set(userId, { present: false, fetchedAt: now });
    return false;
  }
}

// #664: user-facing notice that the payer switched to their own key mid-turn.
// Persists a system chat row (visible on reload) and fans the event out live
// over the global WS + the session bus (the resumable GET /events SSE) — the
// proxy has no handle on the turn's POST SSE, but the dev-chat client listens
// on both side channels. Entirely best-effort: a failed notice must never fail
// the API call.
//
// #1088: the caller decides WHETHER to emit. This used to be gated only by the
// per-turn registry flag, so it re-announced on every chat once credits were
// out; it now runs at most once per user per UTC day
// (limits.claimByokSwitchNotice). The copy is day-scoped to match — it is no
// longer describing just "this turn".
async function emitSwitchNotice(pool, sessionId, userId, window = 'daily') {
  const text = window === 'weekly'
    ? 'Your free weekly AI credits ran out. Work is now continuing on your Anthropic API key. Credits reset Monday 00:00 UTC.'
    : 'Your free daily AI credits ran out. Work is now continuing on your Anthropic API key. Credits reset at midnight UTC.';
  try {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, text, JSON.stringify({ billingSwitch: true })]
    );
  } catch (err) {
    log.warn('anthropic-proxy', 'Failed to persist billing-switch notice', {
      sessionId, userId, err: err.message,
    });
  }
  // A proxy-minted _seq can't collide with the chat handler's
  // `${prefix}-${n}` stream, and the client dedups the WS/bus overlap on
  // this exact string.
  const seq = `byok-switch-${sessionId}-${Date.now().toString(36)}`;
  try {
    const { broadcastGlobal } = require('../services/ws');
    broadcastGlobal({
      type: 'session_event', sessionId, event: 'billing_switched',
      _seq: seq, text,
    });
  } catch (err) {
    log.warn('anthropic-proxy', 'Failed to broadcast billing switch', { sessionId, err: err.message });
  }
  try {
    const sessionBus = require('../services/session-bus');
    sessionBus.publish(sessionId, { type: 'billing_switched', _seq: seq, text });
  } catch (err) {
    log.warn('anthropic-proxy', 'Failed to publish billing switch to bus', { sessionId, err: err.message });
  }
}

// #800: accumulate this call's cost onto the session's coding-agent
// spend ledger (chat_sessions.agent_cost_cents) — the platform's only
// per-change cost record. Everything else the proxy does with
// result.costCents is in-memory (budget trackers) or per-user-per-day
// (llm_usage), so without this the agent's spend — the large majority of
// what a change costs — is unattributable to the change forever.
//
// Called from BOTH settle points (BYOK and platform key) so payer choice
// doesn't change what gets recorded: this is a list-price cost record,
// not a billing record.
//
// Three gates, all "don't record it":
//   - `isSyncTurn`: platform-driven merge-conflict / sync-with-main
//     turns bill system_token_usage and run on a fixed model. They are
//     housekeeping, not a consequence of the user's model choice.
//   - zero cost: a killed or empty call shouldn't churn the row.
//   - no sessionId: the id comes from a signed JWT claim
//     (middleware/anthropic-proxy-auth.js) and is read with optional
//     chaining, so never build `WHERE id = undefined`.
//
// FIRE-AND-FORGET by contract: never awaited into the response path, and
// a failure is a log.warn and nothing more. Bookkeeping must not be able
// to fail or delay a turn — same posture as emitSwitchNotice above.
//
// #2592: it records WHICH MODEL spent it, too. The ledger column has no
// model dimension, so services/model-costs.js had to leave the agent's
// spend out of its per-model aggregate entirely — which is why the
// observed average and median on the Model costs console read far below
// what a change really costs. The proxy is the one place that knows: the
// stream reports the model it actually ran on (falling back to the one
// the request asked for), so the breakdown is recorded rather than
// inferred. A call whose model could not be determined still lands on the
// ledger; it just adds no per-model row.
//
// ONE STATEMENT, not two. The breakdown rides on a CTE over the ledger
// UPDATE so the pair cannot half-happen: a session's per-model rows sum to
// its ledger, or neither was written. That is what lets a reader trust
// either number on its own.
const LEDGER_SQL =
  `UPDATE chat_sessions SET agent_cost_cents = agent_cost_cents + $1 WHERE id = $2`;

const LEDGER_WITH_MODEL_SQL =
  `WITH ledger AS (
     UPDATE chat_sessions SET agent_cost_cents = agent_cost_cents + $1 WHERE id = $2
     RETURNING id
   )
   INSERT INTO chat_session_agent_model_costs (session_id, model, cost_cents)
     SELECT ledger.id, $3::varchar, $1::numeric FROM ledger
   ON CONFLICT (session_id, model) DO UPDATE
     SET cost_cents = chat_session_agent_model_costs.cost_cents + EXCLUDED.cost_cents,
         updated_at = NOW()`;

// The breakdown column is VARCHAR(128); a model id is far shorter than
// that, but an upstream that answered with something long must not turn a
// bookkeeping write into an error.
const MAX_MODEL_ID = 128;

function noteAgentSpend(pool, { sessionId, costCents, isSyncTurn, model }) {
  if (isSyncTurn) return;
  if (!sessionId) return;
  const cents = Number(costCents);
  if (!Number.isFinite(cents) || cents <= 0) return;
  const modelId = (typeof model === 'string' ? model.trim() : '').slice(0, MAX_MODEL_ID);
  Promise.resolve()
    .then(() => (modelId
      ? pool.query(LEDGER_WITH_MODEL_SQL, [cents, sessionId, modelId])
      : pool.query(LEDGER_SQL, [cents, sessionId])))
    .catch((err) => {
      log.warn('anthropic-proxy', 'Failed to record agent spend on session', {
        sessionId, costCents: cents, model: modelId || null, err: err.message,
      });
    });
}

function anthropicProxyRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  if (!config.anthropicApiKey) {
    log.warn('anthropic-proxy', 'ANTHROPIC_API_KEY not set — proxy will 502 platform-key requests');
  }

  // Scoped JSON parser. Global parser (server.js) is skipped for our
  // path so we can carry our own 32mb limit — Anthropic itself caps
  // request bodies at 32MB, and a normal CC turn can carry several
  // MB of file context. See server.js comment near the global
  // express.json() mount for context.
  router.use(express.json({ limit: '32mb' }));

  // Same shape as the push-proxy rate-limit in internal.js — bounds a
  // runaway CC turn (or a malicious prompt looping API calls) to
  // 60/min/session. Honest CC turns make a handful of API calls per
  // turn, well under this. Independent of the budget cap; this just
  // bounds API call rate.
  const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `session:${req.workerSession?.sessionId || 'anon'}`,
    handler: (req, res) => {
      log.warn('anthropic-proxy', 'Rate-limited', {
        sessionId: req.workerSession?.sessionId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // Catch-all under the proxy prefix. Express 4 / path-to-regexp v0
  // matches `*` against the remainder, accessible as req.params[0].
  router.all(`${ROUTE_PREFIX}*`, anthropicProxyAuth, proxyLimiter, async (req, res) => {
    const sessionId = req.workerSession?.sessionId;
    const userId = await resolveUserId(pool, sessionId);
    if (!userId) {
      // No session row in DB (or the session has no user). Refuse —
      // we can't enforce a budget for an anonymous caller, and a
      // missing session row likely means the JWT outlived its row.
      return res.status(403).json({ ok: false, code: 'session_not_found' });
    }

    // #361: merge-conflict / sync turns are platform housekeeping and
    // bill the dedicated system-token budget, not the owner's allowance.
    // The worker records the in-flight turn's mode in its warm registry;
    // read it synchronously to decide which cap+tracker to gate against.
    let workerMod = null;
    try { workerMod = require('../services/worker'); } catch {}
    const isSyncTurn = (() => {
      try { return !!workerMod && workerMod.getActiveTurnMode(sessionId) === 'sync'; }
      catch { return false; }
    })();

    // Resolve effective cap + current spend snapshot. Both come from
    // small caches (limits.js's own 10s cache for the cap, our
    // per-user / system budget tracker for the daily total) so the
    // steady-state cost per Anthropic call is one hash-map lookup, not a
    // DB roundtrip.
    // #1788: the per-user allowance is two caps now — daily and weekly —
    // and either may be switched off (0/unset), so every gate below asks
    // resolveCaps which ones apply rather than comparing one number.
    // Sync turns are unchanged: they bill the single system-token bucket,
    // which has no weekly layer.
    const caps = isSyncTurn
      ? {
          dailyApplies: true,
          dailyLimitCents: await limits.getSystemTokensLimitCents(pool),
          weeklyApplies: false,
          weeklyLimitCents: 0,
        }
      : limits.resolveCaps(await limits.getUserCreditEntitlement(pool, userId));
    const capCents = caps.dailyLimitCents;
    const budget = isSyncTurn
      ? await refreshSystemBudget(pool)
      : await refreshUserBudget(pool, userId);
    const weeklyBudget = caps.weeklyApplies
      ? await refreshUserWeeklySpend(pool, userId)
      : null;
    const spentBeforeCall = budget.totalAtCheckpointCents + budget.liveDeltaCents;
    const weeklySpentBeforeCall = weeklyBudget
      ? weeklyBudget.totalAtCheckpointCents + weeklyBudget.liveDeltaCents
      : 0;
    const dailyOver = caps.dailyApplies && spentBeforeCall >= caps.dailyLimitCents;
    const weeklyOver = caps.weeklyApplies && weeklySpentBeforeCall >= caps.weeklyLimitCents;
    const noAllowance = !caps.dailyApplies && !caps.weeklyApplies;
    // Whichever window is actually binding decides the copy the user sees.
    const boundWindow = weeklyOver ? 'weekly' : 'daily';
    const messageFor = (win) => {
      if (isSyncTurn) {
        return `System token budget reached ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`;
      }
      if (noAllowance) return NO_ALLOWANCE_MESSAGE;
      return win === 'weekly'
        ? `Weekly limit reached ($${(caps.weeklyLimitCents / 100).toFixed(2)}). Resets ${limits.WEEKLY_RESET_LABEL}.`
        : `Daily limit reached ($${(capCents / 100).toFixed(2)}). Resets at midnight UTC.`;
    };
    const overMessage = messageFor(boundWindow);

    const upstreamPath = req.params[0] ? `/${req.params[0]}` : '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstreamUrl = `${anthropicStream.ANTHROPIC_UPSTREAM}${upstreamPath}${qs}`;

    // #664: per-call payer resolution for build/scout turns. The daily
    // allowance is exhausted when EITHER the user's own cap or the
    // platform-wide global cap is spent — in both cases a user with a
    // BYOK key on file spills onto their own key instead of erroring.
    // Sync turns never spill; keyless users fall through to the exact
    // gate/kill behaviour below (the global-cap crossing deliberately
    // does NOT add a new 429 for them — non-regressive).
    if (!isSyncTurn) {
      const userOver = dailyOver || weeklyOver || noAllowance;
      const globalCap = await limits.getGlobalLimitCents(pool);
      const globalSpend = await refreshGlobalSpend(pool);
      const globalOver =
        globalSpend.totalAtCheckpointCents + globalSpend.liveDeltaCents >= globalCap;
      if (userOver || globalOver) {
        const byokKey = await limits.loadUserApiKey(pool, userId, config.dataEncryptionKey);
        if (byokKey) {
          // Two gates, deliberately different in scope (#1088):
          //   markTurnByokSwitched — per turn, cheap and in-process. Keeps the
          //     operator log line at one per turn, exactly as before.
          //   claimByokSwitchNotice — per user per UTC day, in the DB. Decides
          //     whether the *user* is told. The per-turn flag alone re-announced
          //     the switch on every chat for the rest of the day.
          // The turn gate runs first so the day claim is only ever paid for
          // once per turn, and the whole block stays non-fatal.
          if (workerMod && workerMod.markTurnByokSwitched(sessionId)) {
            const noticed = await limits.claimByokSwitchNotice(pool, userId);
            log.info('anthropic-proxy', 'Turn switched to BYOK key mid-turn', {
              sessionId, userId, notified: noticed,
            });
            if (noticed) await emitSwitchNotice(pool, sessionId, userId, boundWindow);
          }
          // The user's own key pays this call: no budget kill (it draws
          // nothing from the allowance) and the observed cost lands in
          // the per-turn BYOK tally for the split settlement at turn end.
          const result = await anthropicStream.forwardCall({
            req,
            res,
            upstreamUrl,
            apiKey: byokKey,
            logTag: 'anthropic-proxy',
            logCtx: { sessionId, userId, upstreamPath, byok: true },
          });
          if (workerMod && result.costCents > 0) {
            workerMod.noteTurnByokSpend(sessionId, result.costCents);
          }
          // #800: BYOK-paid work still costs the change the same at list
          // price, so it lands on the ledger identically.
          noteAgentSpend(pool, {
            sessionId, costCents: result.costCents, isSyncTurn, model: result.model,
          });
          if (result.status === 401 || result.status === 403) {
            log.warn('anthropic-proxy', 'BYOK key rejected by Anthropic upstream', {
              sessionId, userId, status: result.status,
            });
          }
          return;
        }
      }
    }

    if (!config.anthropicApiKey) {
      return res.status(502).json({ ok: false, code: 'no_platform_key' });
    }

    // Start-of-call gate: if we already know we're over cap, refuse
    // before opening any socket to Anthropic. The gate uses the cached
    // snapshot, so it's only as fresh as BUDGET_CACHE_TTL_MS — but
    // mid-stream kill catches anything the gate misses. Since #664 this
    // only fires for callers with NO usable BYOK key (key-holders were
    // switched above).
    if (dailyOver || weeklyOver || noAllowance) {
      log.info('anthropic-proxy', 'Start-of-call gate fired', {
        sessionId, userId, isSyncTurn, spentCents: spentBeforeCall, capCents,
        window: noAllowance ? 'none' : boundWindow,
        weeklySpentCents: weeklySpentBeforeCall,
        weeklyCapCents: caps.weeklyApplies ? caps.weeklyLimitCents : null,
      });
      return res.status(429).json({
        ok: false,
        code: 'budget_exceeded',
        message: overMessage,
      });
    }

    // #664: when the caller HAS a key on file, don't truncate the
    // boundary call — the stream-kill would surface as a hard API error
    // to the CLI even though the very next call would switch payers.
    // Let this one call finish on the platform key (overshoot bounded to
    // one call's cost, logged below) and let the next call's gate do the
    // switch. Keyless users and sync turns keep the kill.
    const killSuppressed = !isSyncTurn && await hasByokKeyOnFile(pool, userId);
    let suppressionLogged = false;

    const result = await anthropicStream.forwardCall({
      req,
      res,
      upstreamUrl,
      apiKey: config.anthropicApiKey,
      logTag: 'anthropic-proxy',
      logCtx: { sessionId, userId, upstreamPath },
      shouldKill: (currentCallCents, model) => {
        // Re-read the snapshot in case a parallel session updated
        // liveDeltaCents while we were streaming. Sync turns track the
        // single system bucket; everything else the per-user bucket.
        const live = isSyncTurn ? systemBudgetCache : userBudgetCache.get(userId);
        const spentEffectiveCents =
          (live ? live.totalAtCheckpointCents + live.liveDeltaCents : spentBeforeCall) +
          currentCallCents;
        // #1788: the weekly bucket runs the same checkpoint+liveDelta
        // arithmetic against its own tracker, and either cap crossing kills.
        const liveWeekly = caps.weeklyApplies ? weeklyBudgetCache.get(userId) : null;
        const weeklyEffectiveCents = caps.weeklyApplies
          ? (liveWeekly
              ? liveWeekly.totalAtCheckpointCents + liveWeekly.liveDeltaCents
              : weeklySpentBeforeCall) + currentCallCents
          : 0;
        const overDailyNow = caps.dailyApplies && spentEffectiveCents > capCents;
        const overWeeklyNow = caps.weeklyApplies && weeklyEffectiveCents > caps.weeklyLimitCents;
        if (overDailyNow || overWeeklyNow) {
          if (killSuppressed) {
            if (!suppressionLogged) {
              suppressionLogged = true;
              log.info('anthropic-proxy', 'Over budget mid-call — kill suppressed (BYOK fallback available)', {
                sessionId, userId,
                window: overWeeklyNow ? 'weekly' : 'daily',
                spentEffectiveCents: spentEffectiveCents.toFixed(2),
                capCents,
                weeklyEffectiveCents: weeklyEffectiveCents.toFixed(2),
                weeklyCapCents: caps.weeklyApplies ? caps.weeklyLimitCents : null,
                currentCallCents: currentCallCents.toFixed(4),
                model,
              });
            }
            return null;
          }
          log.info('anthropic-proxy', 'Mid-stream kill — over budget', {
            sessionId, userId,
            window: overWeeklyNow ? 'weekly' : 'daily',
            spentEffectiveCents: spentEffectiveCents.toFixed(2),
            capCents,
            weeklyEffectiveCents: weeklyEffectiveCents.toFixed(2),
            weeklyCapCents: caps.weeklyApplies ? caps.weeklyLimitCents : null,
            currentCallCents: currentCallCents.toFixed(4),
            model,
          });
          return 'over_budget';
        }
        return null;
      },
    });

    // Fold this call's cost into the user's running tracker so the
    // next request sees it. Even on kill we count what we sent — the
    // worker really did consume those tokens (Anthropic charges for
    // partial generations). Platform-billed user spend also counts
    // toward the global tracker (#664) so the global-cap crossing is
    // visible mid-turn.
    if (result.costCents > 0) {
      const live = isSyncTurn ? systemBudgetCache : userBudgetCache.get(userId);
      if (live) {
        live.liveDeltaCents += result.costCents;
      }
      if (!isSyncTurn) {
        // #1788: platform-billed user spend draws down the weekly bucket
        // as well, so a mid-turn weekly crossing is visible to the next call.
        const liveWeekly = weeklyBudgetCache.get(userId);
        if (liveWeekly) liveWeekly.liveDeltaCents += result.costCents;
        // #2598: and to the user. This call has RETURNED and been priced —
        // the same figure the kill gate above would refuse the next one on —
        // so the weekly meter can tick now rather than when the turn's ledger
        // receipt is written. Every coding-agent call the platform key pays
        // for passes through here, which is what makes "$x left this week"
        // move every few seconds during a build. Sync turns bill the system
        // bucket, which is nobody's meter, and a BYOK-switched call (handled
        // far above) draws nothing from the pool.
        budgetLive.notifySpend(pool, userId, {
          liveWeeklySpentCents: liveWeekly
            ? liveWeekly.totalAtCheckpointCents + liveWeekly.liveDeltaCents
            : null,
        });
      }
      if (!isSyncTurn && globalBudgetCache) {
        globalBudgetCache.liveDeltaCents += result.costCents;
      }
    }
    // #800: same cost, recorded durably against the change rather than
    // only in the in-memory trackers above. Counted on kills too, for the
    // same reason the trackers count them — the tokens were consumed.
    noteAgentSpend(pool, {
      sessionId, costCents: result.costCents, isSyncTurn, model: result.model,
    });
    if (result.killed) {
      log.info('anthropic-proxy', 'Killed call settled', {
        sessionId, userId,
        currentCallCents: result.costCents.toFixed(4),
        model: result.model,
      });
    }
  });

  return router;
}

module.exports = anthropicProxyRoutes;
// #800: exposed for tests/anthropic-proxy-agent-spend.test.js. The ledger
// has no UI, so its gates (sync turn / zero cost / missing session) and
// its swallow-on-failure contract are only observable through a direct
// unit test. Attached as a property so `require(...)(config)` — how
// server.js mounts the router — keeps working unchanged.
module.exports.noteAgentSpend = noteAgentSpend;
