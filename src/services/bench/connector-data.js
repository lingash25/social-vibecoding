'use strict';

// What a full admin's connector session may read of the Homeroom bot and of
// the platform's recent before/after screenshots, beside the benchmark
// (services/bench/studio.js, routes/bench-studio.js): the same data the
// console's Homeroom bot section (services/homeroom-bot.js adminPayload) and
// its Screenshot gallery (routes/gallery.js) show, curated field by field so
// a field added to either screen later does not reach a connector by
// accident. Writes stay the console's, except a run's rating, which is how a
// run is labelled for the benchmark, and the bot's settings, saved through
// the console's own writeSettings (saveSettings).

const log = require('../logger');
const { RESULT_STATUSES } = require('../shots-files');

const clipText = (value, max) => {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise', 'budget']);
const SLUG_RE = /^[a-z0-9-]{1,120}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// A person's week lists at most this many runs; its total is always the
// whole week's.
const MAX_PERSON_RUNS = 200;

// One person's charged runs this week, newest first: the runs whose cost
// counts toward their weekly building time (homeroom-bot-dm.js
// weeklySpentCents reads the same rows): charged, and theirs as the payer,
// or as the requester when nobody else asked the bot to start it.
const PERSON_USER_SQL = 'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1';
const PERSON_RUNS_SQL = `
  SELECT r.id, a.slug AS app_slug, r.issue_number, r.mode, r.verdict, r.read_reason,
         r.cost_usd::float8 AS cost_usd, r.build_cost_usd::float8 AS build_cost_usd,
         r.payer_user_id, r.build_ok, r.build_error, r.build_at, r.build_queued_at, r.build_branch, r.created_at,
         r.build_session_id, r.live_build_waiting_at, r.awaiting_go_at
    FROM homeroom_bot_runs r
    JOIN apps a ON a.id = r.app_id
    LEFT JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
   WHERE r.charged AND COALESCE(r.payer_user_id, q.user_id) = $1 AND r.created_at >= $2
   ORDER BY r.id DESC
   LIMIT $3`;
const MAX_SHOT_IMAGES = 12;
const MAX_SHOT_IMAGE_BYTES = 8 * 1024 * 1024;
// A failed run's reason in full: the gallery stores up to 2000 characters, and
// the cause is usually past the first 200.
const MAX_SHOT_FAILURE = 1200;

/**
 * Whose weekly building time a run counts toward (homeroom-bot-dm.js
 * weeklySpentCents): none when it is not charged (a shadow run, or one the
 * bot caused itself); else its payer, 'asked' when somebody asked the bot
 * to start or change it, 'requester' when it is the request's own. Pure.
 */
function billingOf(r) {
  if (r.charged === false) return { charged: false, payer: null, paidAs: null };
  if (r.charged == null) return null;
  return {
    charged: true,
    payer: r.payer_username || null,
    paidAs: r.payer_user_id != null ? 'asked' : 'requester',
  };
}

/** The person a request names (`username`), checked, or null. Pure. */
function personFilter(q = {}) {
  const name = typeof q.username === 'string' ? q.username.trim().replace(/^@/, '') : '';
  return USERNAME_RE.test(name) ? name : null;
}

/**
 * One person's week of building time: their cap, what they have spent of it
 * since Monday 00:00 UTC, and the charged runs that spent it, newest first,
 * with each request's total. `found: false` for a username nobody has.
 */
async function personWeek(pool, settings, username, deps = {}) {
  const dm = deps.dm || require('../homeroom-bot-dm');
  const weekStart = (deps.weekStartUtc || require('../limits').weekStartUtc)();
  const { rows: users } = await pool.query(PERSON_USER_SQL, [username]);
  if (!users[0]) return { username, found: false };
  const userId = Number(users[0].id);
  const [capCents, spentCents, { rows }] = await Promise.all([
    dm.weeklyCapCents(pool, settings, userId),
    dm.weeklySpentCents(pool, userId),
    pool.query(PERSON_RUNS_SQL, [userId, weekStart, MAX_PERSON_RUNS + 1]),
  ]);
  const runs = rows.slice(0, MAX_PERSON_RUNS).map((r) => {
    const costUsd = num(r.cost_usd);
    const buildCostUsd = num(r.build_cost_usd);
    return {
      id: Number(r.id),
      app: r.app_slug || null,
      issueNumber: num(r.issue_number),
      verdict: r.verdict || null,
      readReason: READ_REASON_RE.test(String(r.read_reason || '')) ? r.read_reason : null,
      paidAs: r.payer_user_id != null ? 'asked' : 'requester',
      costUsd,
      buildCostUsd,
      totalUsd: Math.round(((costUsd || 0) + (buildCostUsd || 0)) * 1e6) / 1e6,
      buildState: buildStateOf(r),
      createdAt: iso(r.created_at),
    };
  });
  const byRequest = new Map();
  for (const run of runs) {
    const key = `${run.app}#${run.issueNumber}`;
    const row = byRequest.get(key) || { app: run.app, issueNumber: run.issueNumber, runs: 0, usd: 0 };
    row.runs += 1;
    row.usd += run.totalUsd;
    byRequest.set(key, row);
  }
  const cap = num(capCents);
  const spent = num(spentCents) || 0;
  return {
    username: users[0].username,
    found: true,
    weekStart: iso(weekStart),
    capCents: cap,
    spentCents: spent,
    leftCents: cap && cap > 0 ? Math.max(0, cap - spent) : null,
    usedUp: !!(cap && cap > 0 && spent >= cap),
    requests: [...byRequest.values()]
      .map((r) => ({ ...r, usd: Math.round(r.usd * 100) / 100 }))
      .sort((a, b) => b.usd - a.usd),
    runs,
    runsComplete: rows.length <= MAX_PERSON_RUNS,
  };
}

// The most of a kept reply passed on: what homeroom-bot.js keptReply keeps
// (4 KB and 12 KB) and the line between them.
const MAX_KEPT_REPLY_CHARS = 16 * 1024 + 200;

/** A run's stored unreadable_reply, checked, or null. Pure. */
function unreadableReplyOf(value) {
  if (!value || typeof value !== 'object') return null;
  const one = (part) => (part && typeof part.text === 'string' && part.text
    ? { text: clipText(part.text, MAX_KEPT_REPLY_CHARS), chars: num(part.chars) }
    : null);
  const out = { reply: one(value.reply), repair: one(value.repair) };
  return out.reply || out.repair ? out : null;
}

/** The run filters the console's verdict ledger takes, checked. Pure. */
function botFilters(q = {}) {
  const app = typeof q.app === 'string' && SLUG_RE.test(q.app) ? q.app : null;
  const verdict = VERDICTS.includes(q.verdict) ? q.verdict : null;
  const before = /^\d+$/.test(String(q.before || '')) ? Number(q.before) : null;
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  return {
    app, before, limit, budgetOnly: verdict === 'budget', verdict: verdict === 'budget' ? null : verdict,
  };
}

/**
 * The settings as a connector reads them, off homeroom-bot.js adminPayload:
 * get_homeroom_bot's `settings`, and what saveSettings answers. Pure.
 */
function settingsOf(p = {}) {
  const s = p.settings || {};
  return {
    mode: s.mode || null,
    // What the console calls it: the stored "shadow" is On, acting for real
    // on every app but the paused ones (live is refused: homeroom-bot.js
    // validateSettingsPatch). The stored value stays in `mode`.
    modeLabel: modeLabelOf(s.mode),
    pausedApps: Array.isArray(s.pausedApps) ? s.pausedApps : [],
    everyoneSince: s.everyoneSince || null,
    models: p.bot?.models || null,
    defaultModel: p.defaultModel || null,
    // What each stage runs on while a bot configuration is current (a
    // first version's triage, plan and build; a later change's triage,
    // plan, build and follow-ups), with the effort and clock it names, over
    // `models` (homeroom-bot.js currentConfigurations).
    configurations: p.configurations || null,
    // What the helper calls ask first (titles, the plan at Make it, chat
    // reads, the content review; services/helper-model.js): the admin's
    // choice, else the built-in GLM.
    helperModel: s.helperModel || p.helperBuiltInModel || null,
    turnSeconds: num(s.turnSeconds),
    concurrency: num(s.concurrency),
    buildConcurrency: num(s.buildConcurrency),
    liveAtOnce: num(s.liveAtOnce),
    perPerson: num(s.perPerson),
    shadowBuilds: !!s.shadowBuilds,
    dmChat: !!s.dmChat,
    // Its voice outside the DM, one switch per place (homeroom-bot-voice.js).
    voiceSession: s.voiceSession !== false,
    voiceIssue: s.voiceIssue !== false,
    voiceChat: s.voiceChat !== false,
    continueReads: s.continueReads !== false,
    proposalCeiling: num(s.proposalCeiling),
    userWeeklyCents: num(s.userWeeklyCents),
    adminWeeklyCents: num(s.adminWeeklyCents),
    // The rest of the console's Settings, so a save through saveSettings
    // reads back every field it can change.
    batchSize: num(s.batchSize),
    turnInputTokens: num(s.turnInputTokens),
    shadowBuildPlatform: !!s.shadowBuildPlatform,
    liveBuildStream: s.liveBuildStream !== false,
  };
}

/**
 * The Homeroom bot as its console section shows it: its settings (models per
 * stage, mode, the paused apps, clocks and caps), its spend this week, the last
 * seven days' verdicts, the queue, and a page of its runs (the verdict
 * ledger), newest first, with each run's replayable benchmark stages.
 */
async function botOverview(pool, config, query = {}, deps = {}) {
  const bot = deps.bot || require('../homeroom-bot');
  const f = botFilters(query);
  const p = await bot.adminPayload(pool, config, f);
  const s = p.settings || {};
  const runs = (p.runs || []).map((r) => ({
    id: Number(r.id),
    app: r.app_slug || null,
    issueNumber: num(r.issue_number),
    mode: r.mode || null,
    verdict: r.verdict || null,
    model: r.model || null,
    buildModel: r.build_model || null,
    costUsd: num(r.cost_usd),
    buildCostUsd: num(r.build_cost_usd),
    question: r.question ? clipText(r.question, 400) : null,
    buildNote: r.build_note ? clipText(r.build_note, 600) : null,
    reason: r.reason ? clipText(r.reason, 300) : null,
    error: r.error ? clipText(r.error, 300) : null,
    // A reply whose verdict could not be read, as the run kept it
    // (homeroom-bot.js keptReply): the reply, and the reply to the turn that
    // asked for its JSON block. The error above is one short line.
    unreadableReply: unreadableReplyOf(r.unreadable_reply),
    budgetStop: r.budget_stop || null,
    // What started this read: the queue row's reason, and for a change what
    // moved (homeroom-bot.js readReasonOf).
    readReason: READ_REASON_RE.test(String(r.read_reason || '')) ? r.read_reason : null,
    // Held by a cap (homeroom-bot.js simulateCaps): which, and its limit,
    // so a held ready verdict says why it has no build.
    held: heldOf(r.cap_suppressed, p.caps),
    // A held ready verdict acted on again with no read of its own, because
    // the request had not changed: the run it reused (homeroom-bot.js
    // reuseHeldVerdict).
    reused: r.reused_run_id != null,
    reusedFrom: num(r.reused_run_id),
    // Its build wherever it got to: a ready verdict queued, building,
    // built or failed, held by a cap, or never built and why (skipped,
    // superseded). A run with none of those has no build.
    build: buildStateOf(r) == null ? null : {
      state: buildStateOf(r),
      ok: r.build_ok, branch: r.build_branch || null, sha: r.build_sha || null, commits: num(r.build_commits),
      // Whole, as the run keeps it (600 characters): a failed turn's reason
      // is followed by what it was last doing and its final message.
      error: r.build_error ? clipText(r.build_error, 600) : null, at: iso(r.build_at), queuedAt: iso(r.build_queued_at),
      // A live build's own session, where its turns run.
      sessionId: num(r.build_session_id),
    },
    rating: r.rating || null,
    ratingNote: r.rating_note ? clipText(r.rating_note, 300) : null,
    labelVerdict: r.label_verdict || null,
    replayStages: Array.isArray(r.replayStages) ? r.replayStages : [],
    // A first version's configuration (services/bot-configs.js), and its
    // review: rounds used and why it stopped (services/bot-review.js).
    botConfig: r.bot_config_version_id ? {
      versionId: Number(r.bot_config_version_id), key: r.bot_config_key || null,
      label: r.bot_config_label ? clipText(r.bot_config_label, 80) : null, version: num(r.bot_config_version),
    } : null,
    // How big the plan the build worked from was, in characters of its
    // markdown spec, to read against how the build went: a first version's
    // spec is asked to plan about 25 minutes of its 40 (homeroom-bot-live.js
    // FIRST_VERSION_SIZE_LINES). Null when the run has no spec.
    specChars: r.build_spec_md ? String(r.build_spec_md).length : null,
    reviewRounds: num(r.review_rounds),
    reviewStop: r.review_stop || null,
    // Whose weekly building time it counted toward, if anybody's.
    billing: billingOf(r),
    issueUrl: r.issueUrl || null,
    createdAt: iso(r.created_at),
  }));
  const person = personFilter(query);
  return {
    ok: true,
    settings: settingsOf(p),
    spend: p.bot ? {
      weeklyLimitCents: num(p.bot.weeklyLimitCents), weeklySpentCents: num(p.bot.weeklySpentCents), hasIncludedKey: !!p.bot.hasIncludedKey,
    } : null,
    totals: p.totals || null,
    // One snapshot (homeroom-bot.js queueSnapshot): `depth` rows waiting and
    // `running` rows running, and the rows listed from that same set: every
    // running one, then the first waiting ones in the order they are read.
    queue: {
      depth: num(p.queue?.depth) || 0,
      running: num(p.queue?.running) || 0,
      listedWaiting: num(p.queue?.listedWaiting),
      listedRunning: num(p.queue?.listedRunning),
      items: (p.queue?.items || []).map((q) => ({
        app: q.app_slug || null, issueNumber: num(q.issue_number), reason: q.reason ? clipText(q.reason, 120) : null,
        enqueuedAt: iso(q.enqueued_at), startedAt: iso(q.started_at),
        // #4533: why it waits and until when (homeroom-bot.js queueWait): a
        // turn running on its session, its payer's week, a platform fault,
        // the bot or its app paused, the project's first version, a build of
        // the same request, the person's limit, a person still writing.
        waiting: q.waiting && CODE_RE.test(String(q.waiting.reason || ''))
          ? {
            reason: q.waiting.reason,
            until: iso(q.waiting.until),
            ...(num(q.waiting.firstVersionIssue) != null ? { firstVersionIssue: num(q.waiting.firstVersionIssue) } : {}),
          } : null,
      })),
    },
    // The DM answers and the voice are counted this week (since Monday 00:00
    // UTC: `period` and `since` say so), unlike `totals`, which are the last
    // 7 days.
    dmChat: p.dmChat ? {
      period: 'this_week', since: iso(weekStart(deps)),
      turns: num(p.dmChat.turns), failed: num(p.dmChat.failed), recovered: num(p.dmChat.recovered),
      people: num(p.dmChat.people), costUsd: num(p.dmChat.costUsd),
    } : null,
    // Its voice outside the DM this week (homeroom-bot-voice.js
    // voiceSummary): codes and counts, never anybody's words.
    voice: p.voice ? { period: 'this_week', since: iso(weekStart(deps)), ...voiceOf(p.voice) } : null,
    // Requests about Homeroom itself (homeroom-bot-move.js moveOfferSummary):
    // the last `days` days' move offers and how each was decided, and the
    // verdicts flagged as about Homeroom that sent none, with why.
    moveOffers: p.moveOffers ? moveOffersOf(p.moveOffers) : null,
    // Errors that should not happen, the last week's (platform-incidents.js).
    incidents: p.incidents ? {
      days: num(p.incidents.days), total: num(p.incidents.total) || 0,
      items: (p.incidents.items || []).slice(0, 20).map((i) => ({
        at: i.at || null,
        kind: CODE_RE.test(String(i.kind || '')) ? i.kind : 'unknown',
        app: i.app || null,
        runId: num(i.runId),
        issueNumber: num(i.issueNumber),
        why: i.why ? clipText(i.why, 300) : null,
        outcome: CODE_RE.test(String(i.outcome || '')) ? i.outcome : null,
      })),
    } : null,
    // The build lane: what is queued and building now, and its last pass
    // (why a queued build is waiting: the budget, a platform fault, …).
    // `queued` and `building` are the shadow lane's own; `live` is the live
    // builds (first versions among them) under way and waiting their turn,
    // which never go through that lane (homeroom-bot.js buildsNow). The
    // top-level `lastPass` is the shadow lane's 60-second drain; the live
    // builds are started by the bot's own loop, whose last pass is
    // `live.lastPass` (when it began and how long it took) and whose pass
    // under way began at `live.passRunningSince`. Run five (13 Oct 2026)
    // first read the shadow lane's as the live loop's.
    buildLane: p.builds ? {
      queued: num(p.builds.queued) || 0,
      building: num(p.builds.building) || 0,
      live: p.builds.live ? {
        building: num(p.builds.live.building) || 0,
        waiting: num(p.builds.live.waiting) || 0,
        lastPass: p.loop ? {
          startedAt: p.loop.startedAt || null, at: p.loop.at || null, ms: num(p.loop.ms),
          refreshed: !!p.loop.refreshed, liveBuilds: num(p.loop.liveBuilds), dispatched: num(p.loop.dispatched),
          paused: CODE_RE.test(String(p.loop.paused || '')) ? p.loop.paused : null,
        } : null,
        passRunningSince: p.loop?.runningSince || null,
      } : null,
      lastPass: p.builds.lane ? {
        at: p.builds.lane.at || null, started: num(p.builds.lane.started), inFlight: num(p.builds.lane.inFlight),
        paused: CODE_RE.test(String(p.builds.lane.paused || '')) ? p.builds.lane.paused : null,
        detail: p.builds.lane.detail ? clipText(p.builds.lane.detail, 200) : null,
      } : null,
      fault: p.builds.fault ? { error: clipText(p.builds.fault.error || '', 200) || null, retryAt: p.builds.fault.retryAt || null } : null,
    } : null,
    runs,
    // One person's week of building time, when the request names them.
    person: person ? await personWeek(pool, s, person, deps) : null,
    filters: { app: f.app, verdict: query.verdict && VERDICTS.includes(query.verdict) ? query.verdict : null },
    nextBefore: runs.length === f.limit ? runs[runs.length - 1].id : null,
  };
}

/**
 * The voice's summary as the connector carries it: the same fields, each
 * read as the type it should be, so nothing else rides along.
 * Pure.
 */
function voiceOf(v) {
  const counts = (o, keys) => Object.fromEntries(keys.filter((k) => num(o?.[k]) != null).map((k) => [k, num(o[k])]));
  const OUTCOMES = ['replied', 'quiet', 'fallback', 'failed'];
  const code = (c) => (CODE_RE.test(String(c || '')) ? String(c) : null);
  // A failure is a code with its stage and status ("v2:rate_limited:429").
  const failure = (c) => (/^[A-Za-z0-9_:+.-]{1,80}$/.test(String(c || '')) ? String(c) : null);
  return {
    turns: num(v.turns) || 0, replied: num(v.replied) || 0, quiet: num(v.quiet) || 0,
    fallback: num(v.fallback) || 0, failed: num(v.failed) || 0, people: num(v.people) || 0, costUsd: num(v.costUsd) || 0,
    byPlace: Object.fromEntries(['session', 'issue', 'chat', 'category', 'message']
      .filter((place) => v.byPlace && v.byPlace[place])
      .map((place) => [place, counts(v.byPlace[place], OUTCOMES)])),
    recentFailures: (v.recentFailures || []).slice(0, 20).map((f) => ({
      at: f.at || null, app: f.app || null, place: code(f.place), ref: num(f.ref), outcome: code(f.outcome),
      error: failure(f.error), failures: (f.failures || []).map(failure).filter(Boolean).slice(0, 10), rounds: num(f.rounds) || 0,
    })),
    asks: {
      byStatus: counts(v.asks?.byStatus, ['queued', 'taken', 'done', 'failed', 'dropped']),
      bySource: Object.fromEntries(Object.entries(v.asks?.bySource || {})
        .filter(([k, n]) => /^[a-z_]{1,20}$/.test(k) && num(n) != null).map(([k, n]) => [k, num(n)])),
      waiting: (v.asks?.waiting || []).slice(0, 20).map((w) => ({
        app: w.app || null, change: num(w.change), issueNumber: num(w.issueNumber), status: code(w.status),
        asks: num(w.asks) || 0, since: w.since || null, tries: num(w.tries) || 0,
      })),
    },
    offers: Object.fromEntries(['file_request', 'withdraw_change', 'close_request']
      .filter((kind) => v.offers && v.offers[kind])
      .map((kind) => [kind, counts(v.offers[kind], ['open', 'deciding', 'done', 'declined', 'failed'])])),
  };
}

/** The bot's stored mode as the console says it: 'off', or 'on' for "shadow" (and "live"). Pure. */
function modeLabelOf(mode) {
  if (!mode) return null;
  return mode === 'off' ? 'off' : 'on';
}

/** The start of this week (Monday 00:00 UTC), as limits.js counts a week. */
function weekStart(deps = {}) {
  try {
    return (deps.weekStartUtc || require('../limits').weekStartUtc)();
  } catch {
    return null;
  }
}

// Why a move offer was not sent (homeroom-bot-move.js MOVE_OFFER_OUTCOMES,
// and `unrecorded`).
const NOT_OFFERED = Object.freeze(['no_requester', 'no_bot', 'repeat_held', 'already_offered', 'not_sent', 'unrecorded']);

/** The move offers' summary as the connector carries it: counts and codes. Pure. */
function moveOffersOf(m) {
  const whys = m.notOfferedByWhy || {};
  return {
    days: num(m.days) || 7,
    sent: num(m.sent) || 0, moved: num(m.moved) || 0, kept: num(m.kept) || 0,
    open: num(m.open) || 0, failed: num(m.failed) || 0,
    notOffered: num(m.notOffered) || 0,
    notOfferedByWhy: Object.fromEntries(NOT_OFFERED.filter((k) => num(whys[k])).map((k) => [k, num(whys[k])])),
    notOfferedRecent: (m.notOfferedRecent || []).slice(0, 10).map((r) => ({
      runId: num(r.runId), app: SLUG_RE.test(String(r.app || '')) ? r.app : null, issueNumber: num(r.issueNumber),
      why: NOT_OFFERED.includes(r.why) ? r.why : null, at: iso(r.at),
    })),
  };
}

// The caps that hold a verdict (homeroom-bot.js simulateCaps).
const HELD_CAPS = Object.freeze(['proposals_per_app', 'proposals_total', 'question_tripwire']);

/**
 * A run a cap held: { cap, limit, why } with the cap's limit from the
 * payload's caps and its reason in words, or null when none held it. Pure.
 */
function heldOf(cap, caps = {}) {
  if (!cap) return null;
  const code = HELD_CAPS.includes(cap) ? cap : null;
  if (!code) return { cap: null, limit: null, why: 'held by a cap' };
  const limit = num(code === 'proposals_per_app' ? caps?.proposalsPerApp
    : code === 'proposals_total' ? caps?.proposalsTotal : caps?.questionsPerAppPerDay);
  return { cap: code, limit, why: heldWords(code, limit) };
}

/** A cap's hold in words, shared with the console (admin-homeroom-bot.tsx heldLine). Pure. */
function heldWords(cap, limit) {
  const n = limit == null ? '' : `${limit} `;
  if (cap === 'proposals_per_app') return `held: ${n}proposals open on this app`;
  if (cap === 'proposals_total') return `held: the bot's ceiling of ${n}proposals open across Homeroom`;
  if (cap === 'question_tripwire') return `held: ${n}questions asked on this app today`;
  return 'held by a cap';
}

// A run's read reason: a queue reason, and for a change what moved.
const READ_REASON_RE = /^[a-z][a-z0-9_]{0,63}(?::[a-z]{1,20})?$/;

/**
 * Where a run's build got to: 'built', 'failed', 'building', 'queued',
 * 'superseded' (a later verdict on the same issue replaced it), 'not_built'
 * (skipped, with why in its error), 'started' (a branch and nothing else
 * yet), 'held' (a ready verdict a cap held), 'awaiting_go' (a plan waiting
 * for its creator's Build it), or null for a run with no build at all.
 * A live build is 'building' from the moment its session is linked until
 * its outcome is recorded, through its review, and 'queued' while it waits
 * its turn: it fills none of the shadow lane's markers, and run 1746, a
 * first version building for 33 minutes, read as no build at all (run
 * four, 13 Oct 2026).
 * Pure.
 */
function buildStateOf(r) {
  if (r.build_ok === true) return 'built';
  if (r.build_ok === false) return 'failed';
  if (r.build_at) return 'building';
  if (r.build_queued_at) return 'queued';
  if (r.build_error) return /^superseded/.test(String(r.build_error)) ? 'superseded' : 'not_built';
  if (r.mode === 'live' && r.awaiting_go_at) return 'awaiting_go';
  if (r.mode === 'live' && r.build_session_id) return 'building';
  if (r.mode === 'live' && r.live_build_waiting_at) return 'queued';
  if (r.build_branch) return 'started';
  // A ready verdict a cap held before any build: its build waits for room
  // (the run's `held` says which cap), rather than reading as no build.
  if (r.cap_suppressed && r.verdict === 'ready') return 'held';
  return null;
}

/** A person's rating of one bot run (the console's Rate), recorded under the connector's admin. */
async function rateRun(pool, { runId, rating, note, labelVerdict, actorId }, deps = {}) {
  const bot = deps.bot || require('../homeroom-bot');
  const out = await bot.rateRun(pool, { id: runId, rating, note, labelVerdict, actorId });
  if (!out.ok) return out;
  const r = out.run || {};
  return { ok: true, run: { id: Number(r.id), rating: r.rating || null, ratingNote: r.rating_note || null, labelVerdict: r.label_verdict || null } };
}

// Every field the console's Save may send (homeroom-bot.js
// validateSettingsPatch); a connector's save sends only these.
const SETTINGS_FIELDS = Object.freeze([
  'mode', 'pausedApps', 'models', 'defaultModel', 'helperModel',
  'weeklyLimitCents', 'userWeeklyCents', 'adminWeeklyCents',
  'turnSeconds', 'turnInputTokens', 'concurrency', 'batchSize', 'buildConcurrency',
  'liveAtOnce', 'perPerson', 'proposalCeiling',
  'shadowBuilds', 'shadowBuildPlatform', 'dmChat', 'voiceSession', 'voiceIssue', 'voiceChat',
  'continueReads', 'liveBuildStream',
  // Homeroom bot parity, P8: pictures' model and weekly cap.
  'imageModel', 'pictureWeeklyCap',
]);

/**
 * A connector's save of the bot's settings, as the console's Save is
 * (routes/admin.js PUT /api/admin/homeroom-bot/settings): the patch through
 * homeroom-bot.js writeSettings, so the same validation, catalog checks and
 * cache invalidation, recorded under `actorId`. A field outside
 * SETTINGS_FIELDS is refused rather than ignored. Answers the fields saved
 * and the settings as get_homeroom_bot reads them.
 */
async function saveSettings(pool, config, { patch, actorId, username = null }, deps = {}) {
  const bot = deps.bot || require('../homeroom-bot');
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const unknown = Object.keys(body).filter((k) => !SETTINGS_FIELDS.includes(k));
  if (unknown.length) return { ok: false, status: 400, error: `Not a setting: ${unknown.slice(0, 5).join(', ')}` };
  const out = await bot.writeSettings(pool, body, actorId, config);
  if (!out.ok) return { ok: false, status: 400, error: out.error };
  log.info('bench', 'Homeroom bot settings updated (connector)', { by: username, patch: Object.keys(body) });
  const p = await bot.adminPayload(pool, config, {});
  return {
    ok: true,
    changed: Object.keys(body),
    settings: settingsOf(p),
    weeklyLimitCents: num(p.bot?.weeklyLimitCents),
  };
}

// Fixed-shape words only: codes and causes from the platform's own sets.
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// How the shots agent ended on each failed run, from its last failed
// dispatch: the platform's code for it, and, when the agent's process died,
// the worker's exit code and cause (oom_killed, container_gone, …; see
// docs/proposal-visuals/shots-agent-diagnostics.md). The failure reason
// alone reads "The shots agent stopped with an error before it finished."
// whatever happened. Best-effort: the listing never fails for it.
async function agentExits(pool, sessionIds) {
  const exits = new Map();
  if (!pool || !sessionIds.length) return exits;
  try {
    const { rows } = await pool.query(
      `SELECT cs.id AS session_id, r.trace_summary->'agentDispatches' AS dispatches
         FROM chat_sessions cs JOIN shot_runs r ON r.id = cs.shots_run_id
        WHERE cs.id = ANY($1::int[]) AND r.state = 'failed'`,
      [sessionIds],
    );
    for (const row of rows) {
      const failed = (Array.isArray(row.dispatches) ? row.dispatches : [])
        .filter((d) => d && d.outcome === 'failed').at(-1);
      if (!failed) continue;
      const exit = {
        code: CODE_RE.test(String(failed.code || '')) ? failed.code : null,
        exitCode: Number.isSafeInteger(failed.exitCode) ? failed.exitCode : null,
        exitCause: CODE_RE.test(String(failed.exitCause || '')) ? failed.exitCause : null,
      };
      if (exit.code || exit.exitCode != null || exit.exitCause) exits.set(Number(row.session_id), exit);
    }
  } catch {
    return new Map();
  }
  return exits;
}

/**
 * The recent before/after screenshots, as the console's Screenshot gallery
 * lists them: merged proposals newest first (keyset paged), each with its
 * declared changes and the shots taken of them, and the legacy captures'
 * counts. Images are read one proposal at a time (shotImages).
 */
async function recentShots(pool, query = {}, deps = {}) {
  const gallery = deps.gallery || require('../../routes/gallery');
  const page = await gallery.listProposals(pool, {
    app: query.app, problem: query.problem, before: query.before, before_id: query.beforeId, limit: query.limit,
  });
  const exits = await agentExits(pool, (page.proposals || [])
    .filter((p) => p.shots?.state === 'failed').map((p) => Number(p.id)));
  const proposals = (page.proposals || []).map((p) => {
    const shots = p.shots || null;
    const artifacts = Array.isArray(shots?.artifacts) ? shots.artifacts : [];
    const claims = (Array.isArray(shots?.claims) ? shots.claims : []).slice(0, 3);
    const results = Array.isArray(shots?.shotResults) ? shots.shotResults : [];
    const statusOf = (id) => {
      const status = results.find((result) => result && result.id === id)?.status;
      return RESULT_STATUSES.includes(status) ? status : null;
    };
    return {
      sessionId: Number(p.id),
      app: p.appSlug || null,
      appName: p.appName || null,
      prNumber: num(p.prNumber),
      prUrl: p.prUrl || null,
      title: p.title ? clipText(p.title, 200) : null,
      mergedAt: iso(p.mergedAt),
      captureState: p.captureState || null,
      captureReason: p.captureReason ? clipText(p.captureReason, 200) : null,
      shots: shots ? {
        state: shots.state || null,
        // Each declared change with how it came out (its shotResults
        // status), or null when the run has no result for it.
        claims: claims.map((c) => ({
          id: c && c.id != null ? String(c.id).slice(0, 96) : null,
          claim: c && c.claim ? clipText(c.claim, 300) : null,
          status: c && c.id != null ? statusOf(c.id) : null,
        })),
        // How many declared changes came out each way, so a run that shot
        // one change of three does not read as a success. A run that ended
        // without results (still under way, stopped before it saved
        // anything, or on an older revision) counts none.
        changes: {
          declared: claims.length,
          ...Object.fromEntries(RESULT_STATUSES.map((status) => [
            status, claims.filter((c) => c && statusOf(c.id) === status).length,
          ])),
        },
        images: artifacts.filter((a) => a.media === 'png').length,
        clips: artifacts.filter((a) => a.media !== 'png').length,
        // What the shots agent noticed broken on the after build besides
        // the declared changes, as the card's "Also noticed" lists it.
        shotNotices: (Array.isArray(shots.shotNotices) ? shots.shotNotices : []).slice(0, 5).map((n) => ({
          text: clipText(n?.text, 300),
          change: n?.change != null ? String(n.change).slice(0, 96) : null,
          screen: n?.screen != null ? String(n.screen).slice(0, 32) : null,
          shot: n?.shot === 'screen' || n?.shot === 'element' ? n.shot : null,
          alsoBefore: n?.alsoBefore === true || n?.alsoBefore === false ? n.alsoBefore : 'unknown',
        })),
        failureCode: shots.failureCode ? String(shots.failureCode).slice(0, 64) : null,
        failure: shots.failureReason ? clipText(shots.failureReason, MAX_SHOT_FAILURE) : null,
        ...(exits.has(Number(p.id)) ? { agentExit: exits.get(Number(p.id)) } : {}),
      } : null,
      legacyCaptures: Array.isArray(p.visuals) ? p.visuals.length : 0,
    };
  });
  return {
    ok: true,
    proposals,
    nextCursor: page.nextCursor ? { before: iso(page.nextCursor.before), beforeId: Number(page.nextCursor.before_id) } : null,
  };
}

/**
 * The current before & after shots over a recent window (routes/gallery.js
 * shotsStats): for proposals merged in the last `days` days, one app or all,
 * how their shots ended, how the declared changes came out, whether the
 * problems the shots agent noted are on the before build too, and why runs
 * failed. Not the console strip's counters, which are the retired
 * route-capture pipeline's over all time; the capture-problem filter does
 * not apply to these.
 */
async function shotStats(pool, query = {}, deps = {}) {
  const gallery = deps.gallery || require('../../routes/gallery');
  return { ok: true, stats: await gallery.shotsStats(pool, { app: query.app, days: query.days }) };
}

/**
 * One merged proposal's before/after shots as images: its verified run's
 * stills (focus first, then context), before and after side by side, at
 * most MAX_SHOT_IMAGES and 8 MB. Captions name the declared change, the
 * screen size and the side; nothing else about the proposal.
 */
async function shotImages(pool, sessionId) {
  const { rows: [s] } = await pool.query(
    `SELECT cs.id, cs.status, cs.shots_run_id, cs.shots_state, cs.pr_number, a.slug AS app_slug
       FROM chat_sessions cs LEFT JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  if (!s) return { ok: false, status: 404, error: 'No such proposal' };
  if (!s.shots_run_id || s.shots_state !== 'verified') {
    return { ok: true, sessionId: Number(s.id), state: s.shots_state || null, images: [], note: 'This proposal has no verified before/after shots.' };
  }
  const { rows } = await pool.query(
    `SELECT id, story_id, viewport, side, variant, content_type, data, object_key, bytes, width, height
       FROM shot_artifacts
      WHERE run_id = $1 AND media = 'png' AND variant IN ('focus', 'context')
      ORDER BY CASE variant WHEN 'focus' THEN 0 ELSE 1 END, story_id, viewport, CASE side WHEN 'base' THEN 0 ELSE 1 END
      LIMIT 40`,
    [s.shots_run_id],
  );
  const images = [];
  let total = 0;
  let leftOut = 0;
  const store = require('../media-store').getStore();
  for (const r of rows) {
    const size = r.object_key ? Number(r.bytes) : Buffer.byteLength(r.data || '');
    if (!size) continue;
    if (images.length >= MAX_SHOT_IMAGES || total + size > MAX_SHOT_IMAGE_BYTES) { leftOut += 1; continue; }
    const data = await require('../media-store').bytes(store, r);
    total += data.length;
    images.push({
      caption: `${String(r.story_id).slice(0, 96)} · ${r.viewport} · ${r.side === 'base' ? 'before' : 'after'} · ${r.variant}`,
      mimeType: r.content_type || 'image/png',
      width: num(r.width),
      height: num(r.height),
      data: data.toString('base64'),
    });
  }
  return { ok: true, sessionId: Number(s.id), app: s.app_slug || null, prNumber: num(s.pr_number), state: s.shots_state, images, leftOut };
}

module.exports = {
  VERDICTS,
  MAX_SHOT_IMAGES,
  MAX_PERSON_RUNS,
  billingOf,
  botFilters,
  botOverview,
  buildStateOf,
  heldOf,
  modeLabelOf,
  moveOffersOf,
  personFilter,
  personWeek,
  rateRun,
  recentShots,
  saveSettings,
  settingsOf,
  SETTINGS_FIELDS,
  shotStats,
  shotImages,
};
