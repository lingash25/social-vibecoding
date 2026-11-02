'use strict';

// The Homeroom bot's changes left red with nobody on them (16 Oct 2026).
//
// When a change of the bot's fails its checks, the bot tries to fix it, and
// when it cannot, it brings the change up to date with main once and then
// hands the failure to a person (homeroom-bot.js runChecksFix, handOff). Its
// head is then "looked at", so the bot never tries again until the head
// moves. Nothing after that ever let the change go: it stayed up for a vote,
// red, holding one of the five slots the project gives the bot
// (PROPOSALS_PER_APP_CAP), and every ready request on the project waited
// behind it. #5193 sat red for two days that way.
//
// So a change of the bot's is withdrawn once all of this holds:
//   - it is up for a vote (promoted), its checks failing on its head;
//   - the bot handed that head's failure to a person (a run of verdict
//     person or failed about that head) more than STALE_DAYS ago;
//   - nothing has happened on the change since, neither a commit nor a
//     message (last_activity_at);
//   - the failure was not one the bot judged the platform's (a
//     checks_not_change incident on it): that is the platform's to fix, and
//     withdrawing would throw a good change away. Nor one the bot is getting
//     fixed for it (a checks_fixing_flake step on it, homeroom-bot-flaky-
//     checks.js): it waits on that fix, which has its own clock.
// It goes the way the bot's other withdrawals go, the system archive with a
// line in the change's own thread (session-lifecycle.js, reason
// 'red-checks'), plus one line on each request it was built for. The request
// stays open, and the bot does not build it again by itself: its last run is
// the hand-off, so the request reads as unchanged since (classifyIssue)
// until somebody says something new on it. Best effort: never a reason a
// refresh fails.

const log = require('./logger');

const BOT_USERNAME = 'homeroom_bot';
const REASON = 'red-checks';
const STALE_DAYS = 3;
const NOT_CHANGE_KIND = 'checks_not_change';
// Homeroom bot parity P6: a change waiting on a fix of a flaky check.
const FLAKE_KIND = 'checks_fixing_flake';

const STALE_RED_SQL = `
  SELECT cs.id, cs.app_id, cs.linked_issues,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
         handed.created_at AS handed_at
    FROM chat_sessions cs
    JOIN users u ON u.id = cs.user_id
    JOIN LATERAL (
      SELECT r.created_at FROM homeroom_bot_runs r
       WHERE r.proposal_session_id = cs.id AND r.mode = 'live'
         AND r.verdict IN ('person', 'failed') AND r.checks_head_sha IS NOT NULL
         AND LOWER(r.checks_head_sha) = LOWER(COALESCE(cs.reviewed_head_sha, cs.checks_commit_sha))
       ORDER BY r.id DESC LIMIT 1
    ) handed ON TRUE
   WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND u.username = $2 AND u.is_synthetic = TRUE
     AND cs.check_state IN ('failing', 'error')
     AND handed.created_at < NOW() - make_interval(days => $3)
     AND cs.last_activity_at < NOW() - make_interval(days => $3)
     AND NOT EXISTS (
       SELECT 1 FROM events e
        WHERE e.session_id = cs.id AND e.event_type = 'platform_incident' AND e.metadata->>'kind' = ANY($4::text[]))
   ORDER BY cs.id`;

/** Pure: the line a withdrawal leaves on each request the change was built for. */
function redNote(title, days = STALE_DAYS) {
  const what = title ? `“${String(title).slice(0, 120)}”` : 'Homeroom bot\'s change for this request';
  return `${what} was withdrawn: its checks failed and nobody changed it for ${days} days. `
    + 'This request stays open for anyone to take up.';
}

function numbersOf(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * Withdraw the bot's changes on one app that have sat red with nobody on
 * them (see the top). Resolves { withdrawn: [sessionId] }. Never throws.
 */
async function sweepStaleRedChanges(pool, { appId, deps = {} } = {}) {
  const withdrawn = [];
  try {
    const { rows } = await pool.query(STALE_RED_SQL, [Number(appId), BOT_USERNAME, STALE_DAYS, [NOT_CHANGE_KIND, FLAKE_KIND]]);
    const lifecycle = deps.sessionLifecycle || require('./session-lifecycle');
    const ws = deps.ws || require('./ws');
    for (const session of rows) {
      if (!(Number(session.id) > 0)) continue;
      let archived = false;
      try {
        ({ archived } = await lifecycle.archiveSession({ pool, sessionId: Number(session.id), reason: REASON, from: 'promoted' }));
      } catch (err) {
        log.warn('homeroom-bot-red-changes', 'Withdrawing a red change partly failed', { sessionId: session.id, err: err.message });
        const { rows: [now] = [] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
        archived = now?.status === 'archived';
      }
      if (!archived) continue;
      withdrawn.push(Number(session.id));
      for (const n of numbersOf(session.linked_issues)) {
        await Promise.resolve(ws.sendSystemMessage(pool, Number(session.app_id), redNote(session.title),
          'system', null, { type: 'issue', ref: n })).catch(() => {});
      }
      log.info('homeroom-bot', 'Withdrew its change: red, handed over, and untouched since', {
        appId, sessionId: Number(session.id), handedAt: session.handed_at,
      });
    }
    if (withdrawn.length && typeof deps.wake === 'function') deps.wake({ appId });
  } catch (err) {
    log.warn('homeroom-bot-red-changes', 'Could not look for red changes to withdraw', { appId, err: err.message });
  }
  return { withdrawn };
}

module.exports = {
  REASON,
  STALE_DAYS,
  STALE_RED_SQL,
  redNote,
  sweepStaleRedChanges,
};
