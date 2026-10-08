const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const usernames = require('../services/usernames');
const ws = require('../services/ws');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const { rankedUsers, weekStartUtc } = require('../services/leaderboard-users');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const {
  WEEKLY_KUDOS_LIMIT,
  WEEKLY_BOUNTY_LIMIT,
  countWeeklyKudosUsed,
  countWeeklyBountiesUsed,
  countWeeklyAllowanceUsed,
} = require('../services/bounties');

// WEEKLY_KUDOS_LIMIT (20) and countWeeklyAllowanceUsed now live in
// src/services/bounties.js — the service places bounties and must not depend
// on this route, which depends on IT (same reasoning as weekStartUtc in
// services/leaderboard-users.js). Both are imported above and RE-EXPORTED
// below unchanged, so every existing importer (src/routes/issues.js,
// tests/kudos.test.js) is unaffected. The FE budget badge picks the number up
// via /api/me/kudos-budget, so nothing hardcodes it client-side either.

// PR states that can receive a kudos. Promoted (open vote) + merging
// (in-flight merge) + merged (landed). Active drafts and paused
// sessions are out — kudos is a "thanks for putting this up for review"
// signal, not encouragement on private work.
const ELIGIBLE_STATES = ['promoted', 'merging', 'merged'];

// #4003: what a change you voted on is waiting for, while it is up for a
// vote: the governed gate the merge decides by (its qualifying Yes votes
// against the threshold, the lazy-consensus clock, the member floor) and its
// checks verdict. Me › Your votes turns these into one phrase ("needs 1 more
// approval", "checks running"). Only the newest PROGRESS_LOOKUPS promoted
// rows are asked, side by side, so a long page costs a bounded number of
// reads (governance and the electorate are cached per app). Best effort: a
// failure leaves the rows without it, and they read as they did before.
const PROGRESS_LOOKUPS = 10;
async function openVoteProgress(pool, sessionIds) {
  const out = new Map();
  const ids = sessionIds.slice(0, PROGRESS_LOOKUPS);
  if (!ids.length) return out;
  try {
    const governance = require('../services/governance');
    const { rows } = await pool.query(
      `SELECT id, app_id, user_id, check_state, promoted_at, created_at,
              requires_explicit_approval
         FROM chat_sessions
        WHERE id = ANY($1::int[]) AND status = 'promoted'`,
      [ids]
    );
    await Promise.all(rows.map(async (row) => {
      const gate = await governance.governedGate(pool, row.app_id, {
        kind: 'pr',
        id: row.id,
        openedAt: row.promoted_at || row.created_at,
        explicitApproval: !!row.requires_explicit_approval,
        authorId: row.user_id ?? null,
      });
      out.set(Number(row.id), {
        checkState: row.check_state || null,
        yes: Number(gate.qualifiedYes) || 0,
        required: Number(gate.required) || 1,
        // The vote side is done: it merges once the checks let it.
        votesDone: !!gate.mergeable,
        // Below the threshold, but an unopposed Yes started the clock.
        lazy: !!gate.lazyArmed,
        // Its votes are in, but none is from a member besides the author.
        needsMember: !!(gate.memberFloor && gate.memberFloor.met === false),
      });
    }));
  } catch (err) {
    log.warn('kudos', 'me/history vote progress skipped', { err: err.message });
    out.clear();
  }
  return out;
}

// Canonical set of per-user fields the GET /api/leaderboard/users handler
// returns, kept in sync with the SELECT aliases in that query. Used to
// validate the optional `fields` allowlist query param: unknown names are
// silently ignored (never reach SQL), so this Set is the single source of
// truth for what a caller may ask for. `username` is always present
// regardless of `fields` — it's listed here too so `?fields=username` works.
const LEADERBOARD_USER_FIELDS = new Set([
  'user_id',
  'username',
  'kudos_received',
  'prs_kudosed',
  'kudos_received_prs_merged',
  'kudos_received_prs_unmerged',
  'prs_merged',
  'last_kudos_at',
  'kudos_given',
  'issues_created',
  // The user's linked Homeroom wallet address (the `ut1...` value stored in
  // users.usernode_pubkey), or null when no wallet is linked. Aliased to
  // `address` in the SELECT below.
  'address',
  // The apps this user is CURRENTLY active on — a JSON array of {slug, name}
  // objects, built by the `active_apps` LATERAL below (mirrors the active-user
  // rules in src/services/active-users.js). Empty array when active on nothing.
  // Always reflects the rolling 10-day window; the `window` param does NOT
  // scope it (same as prs_merged). Under include_0_values=0 an empty [] is
  // KEPT (it's neither 0 nor null), consistent with the empty {} kudos_given map.
  'active_apps',
]);

// Shape a single leaderboard/users row per the optional `fields` /
// `include_0_values` query params. `selectedKeys` is null (return all keys)
// or a Set of allowlisted field names to project down to. `dropEmpty` drops
// any field whose value is literally 0 or null (strict equality — an empty
// {} kudos_given map or a present timestamp is KEPT). `username` is ALWAYS
// present, no matter the params. Projection happens first, then zero/null
// filtering, then the username invariant is re-asserted.
function shapeLeaderboardRow(row, selectedKeys, dropEmpty) {
  // Start from username so it can never be projected or filtered away.
  const out = { username: row.username };
  for (const key of LEADERBOARD_USER_FIELDS) {
    if (key === 'username') continue;
    if (selectedKeys && !selectedKeys.has(key)) continue;
    const value = row[key];
    if (dropEmpty && (value === 0 || value === null)) continue;
    out[key] = value;
  }
  return out;
}

// weekStartUtc now lives in src/services/leaderboard-users.js — the service
// buckets its own week and must not depend on this route, which depends on IT.
// It is imported at the top and RE-EXPORTED below unchanged, so every existing
// importer (src/routes/issues.js, tests/kudos.test.js) is unaffected.

// Single round-trip count of kudos this user has given in the current
// week bucket. Uses the (giver_user_id, week_start) index. Returns the
// number; never null.
async function countKudosGivenThisWeek(pool, userId, weekStart) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM pr_kudos
       WHERE giver_user_id = $1 AND week_start = $2`,
    [userId, weekStart]
  );
  return rows[0]?.c || 0;
}

// countWeeklyAllowanceUsed — the SHARED weekly "give" allowance across PR
// kudos and issue bounties — now lives in src/services/bounties.js alongside
// the constant it enforces. Imported at the top and re-exported below.

// Fetch the kudos count + giver usernames + my_kudos flag for a
// session. Used both by `GET /api/sessions/:id/kudos` and by the
// in-line subqueries on /promoted and /merged (though those use
// COUNT(*) directly for performance — the full giver list only
// loads when the hover popover requests it).
async function loadKudosForSession(pool, sessionId, viewerUserId) {
  // Direct PR kudos UNION ALL the issue bounties that were AWARDED to this PR
  // on merge — a bounty resolves into kudos credit for the closing PR's
  // author, so both surface as kudos here (matching the leaderboards and the
  // card counts). LEFT JOIN on the bounty side so an awarded bounty whose
  // giver was since deleted (giver_user_id → NULL) still counts; it just
  // can't be attributed to a username in the popover.
  // Each branch tags its rows with a `source` so my_kudos_direct (below)
  // can tell a retractable direct kudos apart from bounty-derived credit.
  const { rows } = await pool.query(
    `SELECT created_at, username, user_id, source FROM (
       SELECT pk.created_at, u.username, u.id AS user_id, 'pr' AS source
         FROM pr_kudos pk
         JOIN users u ON u.id = pk.giver_user_id
        WHERE pk.session_id = $1
       UNION ALL
       SELECT ib.awarded_at AS created_at, bu.username, ib.giver_user_id AS user_id, 'bounty' AS source
         FROM issue_bounties ib
         LEFT JOIN users bu ON bu.id = ib.giver_user_id
        WHERE ib.awarded_session_id = $1 AND ib.status = 'awarded'
     ) k
     ORDER BY created_at ASC NULLS LAST`,
    [sessionId]
  );
  const count = rows.length;
  const myKudos = viewerUserId
    ? rows.some((r) => r.user_id === viewerUserId)
    : false;
  // my_kudos_direct: the viewer has an actual pr_kudos row (retractable
  // via DELETE), as opposed to credit that arrived through an awarded
  // issue bounty (not retractable here).
  const myKudosDirect = viewerUserId
    ? rows.some((r) => r.source === 'pr' && r.user_id === viewerUserId)
    : false;
  // Only rows with a resolvable username make the giver list; a deleted-user
  // bounty still counts above but has no name to show.
  const givers = rows
    .filter((r) => r.username)
    .map((r) => ({
      username: r.username,
      createdAt: r.created_at,
    }));
  return { count, givers, my_kudos: myKudos, my_kudos_direct: myKudosDirect };
}

function kudosRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for the session-id-addressed kudos routes:
  // collab-level access, 404 on deny (kudos is a build-surface signal).
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // --------------------------------------------------------------
  // POST /api/sessions/:id/kudos — give a kudos.
  //
  // Status codes:
  //   200 ok           — kudos recorded
  //   401 unauth       — handled by authMiddleware upstream
  //   404 not_found    — session doesn't exist, OR is in an ineligible
  //                       state (active / paused / archived). We use 404
  //                       not 403 because from the user's perspective
  //                       "no PR to vote on here" is the right framing.
  //   403 forbidden    — would be self-kudos (author == giver)
  //   409 conflict     — already gave kudos to this PR
  //   429 too_many     — weekly quota exceeded
  // --------------------------------------------------------------
  router.post('/api/sessions/:id/kudos', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    try {
      // Fetch the session + app context in one query so the broadcast
      // payload below has appSlug without a second round-trip.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.status, cs.pr_number, cs.pr_title,
                cs.app_id, a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
        [sessionId]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = sessionRows[0];

      if (!ELIGIBLE_STATES.includes(session.status)) {
        return res.status(404).json({
          error: `Kudos can only be given on promoted, merging, or merged PRs (this PR is "${session.status}")`,
        });
      }

      // session.user_id can be NULL if the original author was deleted
      // (chat_sessions.user_id has ON DELETE SET NULL). Treat as
      // "no self-kudos to worry about" — the kudos still attaches to
      // the session and shows up in the PR leaderboard; it just won't
      // credit anyone in the user leaderboard, which already filters
      // out NULL authors.
      if (session.user_id && session.user_id === req.user.id) {
        return res.status(403).json({ error: 'Cannot give kudos to your own PR' });
      }

      const weekStart = weekStartUtc();

      // Quota check. Race window: two parallel POSTs from the same
      // user could both pass this check and both insert, allowing a
      // single user to overshoot the cap by at most 1 across N
      // parallel requests. Bounded, rare, not security-critical; the
      // alternative is a per-user advisory lock which adds complexity
      // for a near-zero-impact race. Documented in the plan.
      // #1688: thanks draw from their own allowance; bounties have theirs
      // (services/bounties.js), so neither can drain the other.
      const given = await countWeeklyKudosUsed(pool, req.user.id, weekStart);
      if (given >= WEEKLY_KUDOS_LIMIT) {
        return res.status(429).json({
          error: `Weekly kudos quota exceeded (${WEEKLY_KUDOS_LIMIT}/week). Resets every Monday 00:00 UTC.`,
          remaining: 0,
          limit: WEEKLY_KUDOS_LIMIT,
        });
      }

      // Insert. UNIQUE(session_id, giver_user_id) handles the dupe
      // case; we surface that as 409 rather than letting the generic
      // 500 handler eat it.
      let inserted;
      try {
        const { rows: insertRows } = await pool.query(
          `INSERT INTO pr_kudos (session_id, giver_user_id, week_start)
           VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [sessionId, req.user.id, weekStart]
        );
        inserted = insertRows[0];
      } catch (err) {
        // Postgres unique_violation
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Already gave kudos to this PR' });
        }
        throw err;
      }

      events.record(pool, {
        type: events.EVENT_TYPES.KUDOS_GIVEN,
        userId: req.user.id,
        appId: session.app_id,
        sessionId,
        metadata: { recipientId: session.user_id || null },
      });

      // Notification for the PR author (skip if no author or self —
      // the self case is already 403'd above, but guard anyway).
      if (session.user_id && session.user_id !== req.user.id) {
        try {
          const { rows: notifRows } = await pool.query(
            `INSERT INTO notifications
               (user_id, app_id, session_id, source_user_id, kind)
             VALUES ($1, $2, $3, $4, 'kudos')
             RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at, read_at`,
            [session.user_id, session.app_id, sessionId, req.user.id]
          );
          if (notifRows.length) {
            // Hydrate with app/sender/session info so the client
            // dropdown renders immediately without another fetch.
            // Same shape that listForUser → serialize produces for
            // history loads.
            const { rows: hydrated } = await pool.query(
              `SELECT n.id, n.kind, n.read_at, n.created_at,
                      n.app_id, a.slug AS app_slug, a.name AS app_name,
                      n.chat_message_id, NULL AS message_content,
                      n.session_id, cs.pr_title, cs.pr_number,
                      su.username AS source_username, n.user_id
                 FROM notifications n
                 LEFT JOIN apps a ON a.id = n.app_id
                 LEFT JOIN chat_sessions cs ON cs.id = n.session_id
                 LEFT JOIN users su ON su.id = n.source_user_id
                 WHERE n.id = $1`,
              [notifRows[0].id]
            );
            if (hydrated.length) {
              const notifications = require('../services/notifications');
              ws.pushNotificationToUser(session.user_id, {
                type: 'notification_new',
                notification: notifications.serialize(hydrated[0]),
              });
            }
          }
        } catch (err) {
          // Notification is best-effort — never fail the kudos itself.
          log.warn('kudos', 'notification emit failed', {
            sessionId, giver: req.user.id, err: err.message,
          });
        }
      }

      // Broadcast updated count so any open PR card and the leaderboard
      // re-render in place.
      try {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM pr_kudos WHERE session_id = $1`,
          [sessionId]
        );
        ws.pushKudosUpdate({
          sessionId,
          appSlug: session.app_slug,
          count: countRows[0]?.c || 0,
          giverUsername: req.user.username,
        });
      } catch (err) {
        log.warn('kudos', 'broadcast failed', { sessionId, err: err.message });
      }

      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - (given + 1));
      log.info('kudos', 'kudos given', {
        sessionId, giverId: req.user.id, weekStart, remaining,
      });
      res.json({ ok: true, kudosId: inserted.id, remaining, limit: WEEKLY_KUDOS_LIMIT });
    } catch (err) {
      log.error('kudos', 'give failed', { sessionId, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // DELETE /api/sessions/:id/kudos — retract a previously given kudos
  // (issue #197: undo for mis-clicks).
  //
  // Status codes:
  //   200 ok        — kudos removed; remaining/limit reflect the
  //                    refunded current-week slot
  //   401 unauth    — handled by authMiddleware upstream
  //   404 not_found — session doesn't exist, OR the viewer has no
  //                    direct kudos row on it (bounty-derived credit
  //                    is not retractable here)
  //
  // No session-status gate: if the row exists it was eligible at give
  // time, and retraction is harmless in any state (the merged list is
  // the primary mis-click surface). The quota refund is emergent —
  // countWeeklyAllowanceUsed counts rows by week_start, so deleting a
  // current-week row frees a slot while deleting an old-week row
  // changes nothing for this week.
  // --------------------------------------------------------------
  router.delete('/api/sessions/:id/kudos', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    try {
      // Session + app context up front (same query shape as the give
      // path) so the broadcast and analytics below have appSlug/appId
      // without extra round-trips.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.status, cs.pr_number, cs.pr_title,
                cs.app_id, a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
        [sessionId]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = sessionRows[0];

      // Single atomic DELETE is the source of truth — no prior
      // existence check needed, and a parallel retract race just
      // 404s on the loser.
      const { rows: deleted } = await pool.query(
        `DELETE FROM pr_kudos
           WHERE session_id = $1 AND giver_user_id = $2
           RETURNING id, week_start`,
        [sessionId, req.user.id]
      );
      if (!deleted.length) {
        return res.status(404).json({ error: 'No kudos to retract on this PR' });
      }

      // Best-effort cleanup of the author's "gave kudos" notification —
      // the underlying event no longer stands, read or unread. Never
      // fail the retract itself over it.
      try {
        const { rows: cleared = [] } = await pool.query(
          `DELETE FROM notifications
             WHERE kind = 'kudos' AND session_id = $1 AND source_user_id = $2
           RETURNING user_id`,
          [sessionId, req.user.id]
        );
        // #3050: the recipient's unread total may just have dropped —
        // refresh their bell and re-badge their iPhone.
        const { pushNotificationToUser } = require('../services/ws');
        for (const userId of new Set(cleared.map((r) => r.user_id))) {
          pushNotificationToUser(userId, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('kudos', 'notification cleanup failed', {
          sessionId, giver: req.user.id, err: err.message,
        });
      }

      events.record(pool, {
        type: events.EVENT_TYPES.KUDOS_RETRACTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId,
        metadata: { recipientId: session.user_id || null },
      });

      // Broadcast the new count so open PR cards / leaderboards
      // re-render in place. `retractedUsername` (instead of
      // giverUsername) tells Kudos.applyLiveUpdate which direction
      // this update went.
      try {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM pr_kudos WHERE session_id = $1`,
          [sessionId]
        );
        ws.pushKudosUpdate({
          sessionId,
          appSlug: session.app_slug,
          count: countRows[0]?.c || 0,
          retractedUsername: req.user.username,
        });
      } catch (err) {
        log.warn('kudos', 'broadcast failed', { sessionId, err: err.message });
      }

      const weekStart = weekStartUtc();
      const given = await countWeeklyAllowanceUsed(pool, req.user.id, weekStart);
      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - given);
      log.info('kudos', 'kudos retracted', {
        sessionId, giverId: req.user.id, weekStart: deleted[0].week_start, remaining,
      });
      res.json({ ok: true, remaining, limit: WEEKLY_KUDOS_LIMIT });
    } catch (err) {
      log.error('kudos', 'retract failed', { sessionId, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/sessions/:id/kudos — count + giver list for hover popover.
  // --------------------------------------------------------------
  router.get('/api/sessions/:id/kudos', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    try {
      // Defensive existence check so we 404 on bogus ids rather than
      // returning a misleading `{ count: 0, ... }`.
      const { rows } = await pool.query(
        `SELECT id FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const data = await loadKudosForSession(pool, sessionId, req.user.id);
      res.json(data);
    } catch (err) {
      log.error('kudos', 'get failed', { sessionId, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/me/kudos-budget — header badge poll target.
  // --------------------------------------------------------------
  router.get('/api/me/kudos-budget', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const weekStart = weekStartUtc();
      // #1688: two allowances. The top-level figures stay the thanks (PR
      // kudos) budget the badge has always shown; `bounties` is the second
      // meter beside it.
      const given = await countWeeklyKudosUsed(pool, req.user.id, weekStart);
      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - given);
      const bountiesGiven = await countWeeklyBountiesUsed(pool, req.user.id, weekStart);
      res.json({
        given_this_week: given,
        remaining,
        limit: WEEKLY_KUDOS_LIMIT,
        week_start: weekStart,
        bounties: {
          given_this_week: bountiesGiven,
          remaining: Math.max(0, WEEKLY_BOUNTY_LIMIT - bountiesGiven),
          limit: WEEKLY_BOUNTY_LIMIT,
        },
      });
    } catch (err) {
      log.error('kudos', 'budget failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/me/history?type=all|kudos|votes&limit=50&before=<ISO ts>
  //
  // Everything the caller has GIVEN — PR kudos, issue-bounty pledges,
  // PR votes, proposal votes — merged reverse-chronologically. Strictly
  // me-scoped (every arm filters on req.user.id); must stay OUT of
  // PUBLIC_PATHS in middleware/auth.js. Keyset pagination on
  // created_at: `nextBefore` is the last row's timestamp, null when
  // the page came back short.
  //
  // Semantics worth remembering: pr_votes/issue_votes are current-state
  // ledgers (the vote route upserts with created_at = NOW() on flip,
  // and re-voting an issue the same way deletes the row), so the vote
  // arms surface "current standing vote, last changed at", not a full
  // cast history. pr_kudos is append-only and complete.
  // --------------------------------------------------------------
  router.get('/api/me/history', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const typeArg = ['all', 'kudos', 'votes'].includes(req.query.type)
      ? req.query.type
      : 'all';
    const limit = clampLimit(req.query.limit === undefined ? '50' : req.query.limit);
    let before = null;
    if (req.query.before !== undefined && req.query.before !== '') {
      const t = Date.parse(req.query.before);
      if (!Number.isFinite(t)) {
        return res.status(400).json({ error: 'Invalid before timestamp' });
      }
      before = new Date(t).toISOString();
    }

    try {
      const params = [req.user.id];
      let beforeIdx = null;
      if (before) {
        params.push(before);
        beforeIdx = params.length;
      }
      // Each arm projects the same column list so the UNION ALL lines
      // up; rows are tagged with a literal `type`. NULL placeholders
      // stay untyped — Postgres resolves them against the sibling arms.
      const cut = (col) => (beforeIdx ? `AND ${col} < $${beforeIdx}` : '');
      const arms = [];
      if (typeArg === 'all' || typeArg === 'kudos') {
        arms.push(`
          SELECT 'kudos' AS type, pk.created_at, NULL AS vote,
                 cs.status AS status,
                 cs.id AS session_id, cs.pr_number, cs.pr_title,
                 au.username AS author_username,
                 a.slug AS app_slug, a.name AS app_name,
                 NULL::int AS issue_number, NULL AS issue_title, NULL AS issue_kind, NULL::int AS issue_id,
                 NULL AS awarded_username, NULL::timestamptz AS awarded_at
            FROM pr_kudos pk
            JOIN chat_sessions cs ON cs.id = pk.session_id
            JOIN apps a ON a.id = cs.app_id
            LEFT JOIN users au ON au.id = cs.user_id
           WHERE pk.giver_user_id = $1 ${cut('pk.created_at')}`);
        arms.push(`
          SELECT 'bounty' AS type, ib.created_at, NULL AS vote,
                 ib.status AS status,
                 NULL::int AS session_id, NULL::int AS pr_number, NULL AS pr_title,
                 NULL AS author_username,
                 a.slug AS app_slug, a.name AS app_name,
                 ib.github_issue_number AS issue_number, NULL AS issue_title, NULL AS issue_kind, NULL::int AS issue_id,
                 wu.username AS awarded_username, ib.awarded_at
            FROM issue_bounties ib
            JOIN apps a ON a.id = ib.app_id
            LEFT JOIN users wu ON wu.id = ib.awarded_user_id
           WHERE ib.giver_user_id = $1 ${cut('ib.created_at')}`);
      }
      if (typeArg === 'all' || typeArg === 'votes') {
        arms.push(`
          SELECT 'pr_vote' AS type, pv.created_at, pv.vote,
                 -- Merged but not live yet (chat_sessions.live_at): going live.
                 CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'going_live' ELSE cs.status END AS status,
                 cs.id AS session_id, cs.pr_number, cs.pr_title,
                 au.username AS author_username,
                 a.slug AS app_slug, a.name AS app_name,
                 NULL::int AS issue_number, NULL AS issue_title, NULL AS issue_kind, NULL::int AS issue_id,
                 NULL AS awarded_username, NULL::timestamptz AS awarded_at
            FROM pr_votes pv
            JOIN chat_sessions cs ON cs.id = pv.session_id
            JOIN apps a ON a.id = cs.app_id
            LEFT JOIN users au ON au.id = cs.user_id
           WHERE pv.user_id = $1 ${cut('pv.created_at')}`);
        arms.push(`
          SELECT 'proposal_vote' AS type, iv.created_at, iv.vote,
                 i.status AS status,
                 NULL::int AS session_id, NULL::int AS pr_number, NULL AS pr_title,
                 NULL AS author_username,
                 a.slug AS app_slug, a.name AS app_name,
                 i.github_issue_number AS issue_number, i.title AS issue_title, i.kind AS issue_kind, i.id AS issue_id,
                 NULL AS awarded_username, NULL::timestamptz AS awarded_at
            FROM issue_votes iv
            JOIN issues i ON i.id = iv.issue_id
            JOIN apps a ON a.id = i.app_id
           WHERE iv.user_id = $1 ${cut('iv.created_at')}`);
      }
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT * FROM (${arms.join('\nUNION ALL\n')}) h
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params
      );

      const progress = await openVoteProgress(pool, rows
        .filter((r) => r.type === 'pr_vote' && r.status === 'promoted' && r.session_id != null)
        .map((r) => Number(r.session_id)));

      const items = rows.map((r) => {
        const item = {
          type: r.type,
          created_at: r.created_at,
          app: { slug: r.app_slug, name: r.app_name },
        };
        if (r.vote != null) item.vote = r.vote;
        if (r.status != null) item.status = r.status;
        if (r.type === 'kudos' || r.type === 'pr_vote') {
          item.pr = {
            sessionId: r.session_id,
            number: r.pr_number,
            title: r.pr_title,
            // NULL when the PR's author account was deleted (LEFT JOIN).
            author: r.author_username || null,
          };
          const next = r.type === 'pr_vote' ? progress.get(Number(r.session_id)) : null;
          if (next) item.progress = next;
        } else if (r.type === 'bounty') {
          item.issue = { number: r.issue_number };
          if (r.status === 'awarded') {
            item.awarded = { username: r.awarded_username || null, at: r.awarded_at };
          }
        } else if (r.type === 'proposal_vote') {
          // `id` is the proposal's own, which its page is addressed by
          // (#app/<slug>/dev/governance/<id>): Me's Your votes links there.
          item.issue = { id: r.issue_id, number: r.issue_number, title: r.issue_title, kind: r.issue_kind };
        }
        return item;
      });
      const nextBefore = rows.length === limit
        ? rows[rows.length - 1].created_at
        : null;
      res.json({ items, nextBefore });
    } catch (err) {
      log.error('kudos', 'me/history failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/leaderboard/prs?window=all|week&limit=20
  // Top PRs by kudos count. Joins author + app for the card render.
  // --------------------------------------------------------------
  router.get('/api/leaderboard/prs', async (req, res) => {
    // Public endpoint (see PUBLIC_PATHS in middleware/auth.js) — no
    // req.user guard; only aggregate, non-private data is returned.
    const windowArg = req.query.window === 'week' ? 'week' : 'all';
    const limit = clampLimit(req.query.limit);
    try {
      const weekStart = weekStartUtc();
      // Window filter is a single WHERE clause; rest of the query is
      // identical. Using parameterized window arg rather than
      // string-interpolating column names — safe.
      // View-private apps are excluded outright: this endpoint is
      // unauthenticated (PUBLIC_PATHS), so their PR titles / app names
      // must never appear here.
      const where = windowArg === 'week'
        ? `WHERE a.view_visibility = 'public' AND c.week_start = $1`
        : `WHERE a.view_visibility = 'public'`;
      const params = windowArg === 'week' ? [weekStart, limit] : [limit];
      const limitParamIdx = windowArg === 'week' ? '$2' : '$1';
      // `credit` unifies the two kudos sources per PR: direct PR kudos and
      // issue bounties AWARDED to the PR on merge. Bounties get a week_start
      // derived from awarded_at with the same Monday-00:00-UTC bucketing as
      // weekStartUtc(), so the ?window=week filter lines up. Rooting the
      // aggregate at this union (not pr_kudos) means a PR credited only by an
      // awarded bounty still appears on the board.
      const { rows } = await pool.query(
        `WITH credit AS (
           SELECT pk.session_id, pk.created_at, pk.week_start
             FROM pr_kudos pk
           UNION ALL
           SELECT ib.awarded_session_id AS session_id,
                  ib.awarded_at AS created_at,
                  date_trunc('week', ib.awarded_at AT TIME ZONE 'UTC')::date AS week_start
             FROM issue_bounties ib
            WHERE ib.status = 'awarded' AND ib.awarded_session_id IS NOT NULL
         )
         SELECT cs.id AS session_id,
                cs.pr_number, cs.pr_url, cs.pr_title,
                -- Merged but not live yet (chat_sessions.live_at): the badge says going live.
                CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS status,
                cs.created_at AS session_created_at,
                u.id AS author_id, u.username AS author_username,
                a.slug AS app_slug, a.name AS app_name,
                COUNT(*)::int AS kudos_count,
                MAX(c.created_at) AS last_kudos_at
           FROM credit c
           JOIN chat_sessions cs ON cs.id = c.session_id
           JOIN apps a ON a.id = cs.app_id
           LEFT JOIN users u ON u.id = cs.user_id
           ${where}
           GROUP BY cs.id, u.id, a.slug, a.name
           ORDER BY kudos_count DESC, last_kudos_at DESC
           LIMIT ${limitParamIdx}`,
        params
      );
      res.json({
        window: windowArg,
        weekStart: windowArg === 'week' ? weekStart : null,
        items: rows,
      });
    } catch (err) {
      log.error('kudos', 'leaderboard/prs failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/leaderboard/users?window=all|week&limit=N
  // Lists ALL users (not just those who've received kudos), ranked by
  // total kudos received on their MERGED PRs (highest first), then by
  // PRs merged, then by most-recent kudos as a final tiebreaker.
  // (Issue #59: kudos earned, not raw merge count, is the headline
  // metric.) Rooted at `users` with LEFT JOINs so a user with zero
  // kudos still shows up. `limit` is optional — omit it to return
  // every user.
  //
  // Per-row stats:
  //   kudos_received              — total kudos on the user's PRs (window-filtered)
  //   prs_kudosed                 — distinct PRs of theirs that got any kudos
  //   kudos_received_prs_merged   — kudos on PRs now 'merged' (window-filtered).
  //                                 The PRIMARY sort key and the headline score.
  //   kudos_received_prs_unmerged — kudos on PRs not 'merged' (window-filtered)
  //   prs_merged                  — count of the user's PRs that landed; now a
  //                                 secondary sort key / detail. ALL-TIME
  //                                 regardless of window: chat_sessions has no
  //                                 merge timestamp, only a 'merged' status, so
  //                                 there's nothing to window it by.
  //   issues_created              — count of issues the user filed (issues.created_by)
  //                                 on public apps, window-filtered by created_at.
  //                                 Display-only detail; NOT a sort key.
  //   active_apps                 — JSON array of {slug, name} for the apps the
  //                                 user is CURRENTLY active on, per the active-
  //                                 user rules in src/services/active-users.js
  //                                 (ever >=60s in a day on the app, AND visited
  //                                 within the last 10 days; collab-private apps
  //                                 only count members; self-hosted apps excluded).
  //                                 Private-VIEW apps ARE included — this reflects
  //                                 every app the user actually uses, not just
  //                                 public-view ones. ALWAYS reflects the rolling
  //                                 10-day window — NOT scoped by the `window`
  //                                 param (like prs_merged). Display-only.
  // --------------------------------------------------------------
  router.get('/api/leaderboard/users', async (req, res) => {
    // Public endpoint (see PUBLIC_PATHS in middleware/auth.js) — no
    // req.user guard; only aggregate, non-private data is returned.
    const windowArg = req.query.window === 'week' ? 'week' : 'all';
    // `limit` is optional now: absent/blank => return all users.
    const hasLimit = req.query.limit !== undefined && req.query.limit !== '';
    // Optional `fields` allowlist: comma-separated field names to project
    // each item down to. Unset/blank => return all keys. Unknown names are
    // silently ignored (intersect with LEADERBOARD_USER_FIELDS); `username`
    // is always kept regardless. The intersection means user input never
    // reaches SQL, so there's no injection surface.
    const fieldsRaw = typeof req.query.fields === 'string' ? req.query.fields : '';
    let selectedKeys = null;
    if (fieldsRaw.trim() !== '') {
      selectedKeys = new Set(
        fieldsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '' && LEADERBOARD_USER_FIELDS.has(s))
      );
      // `username` is always present; force it in so the projection never
      // strips it (and so `?fields=username` is a valid no-op selection).
      selectedKeys.add('username');
    }
    // Optional `include_0_values`: only the exact string '0' enables dropping
    // fields whose value is literally 0 or null. Unset / '1' / anything else
    // keeps them (default 1).
    const dropEmpty = req.query.include_0_values === '0';
    try {
      const weekStart = weekStartUtc();
      // The RANKING lives in src/services/leaderboard-users.js. The home
      // screen's Challenges widget shows the same ranks in its LEADERBOARD
      // fill, and two copies of this ORDER BY would eventually disagree about
      // who is #3 — so there is one copy. This route still owns everything
      // about the REQUEST: the window/limit params, the `fields` projection
      // and the response envelope.
      const rows = await rankedUsers(pool, {
        window: windowArg,
        limit: hasLimit ? clampLimit(req.query.limit) : null,
        weekStart,
        weeklyKudosLimit: WEEKLY_KUDOS_LIMIT,
      });
      // Shape each item per the optional `fields` / `include_0_values`
      // params (projection then zero/null filtering, username always kept).
      // When neither is set this is a no-op and rows pass through unchanged.
      // The envelope (window/weekStart) is untouched.
      const items =
        selectedKeys || dropEmpty
          ? rows.map((r) => shapeLeaderboardRow(r, selectedKeys, dropEmpty))
          : rows;
      res.json({
        window: windowArg,
        weekStart: windowArg === 'week' ? weekStart : null,
        items,
      });
    } catch (err) {
      log.error('kudos', 'leaderboard/users failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/leaderboard/users/:username/prs?limit=50&before=<ISO ts>
  //
  // (#60) Profile drill-in from the Top-users tab: every PR the user
  // has PROPOSED, newest first, with per-PR kudos credit and headline
  // stats. Public via the '/api/leaderboard/' PUBLIC_PATHS prefix
  // (src/middleware/auth.js), so the filters are privacy-critical:
  //   - public apps only (view_visibility = 'public')
  //   - no headless auto sessions
  //   - proposed PRs only: promoted / merging / merged, plus archived
  //     rows that were once promoted (closed PRs). Archived-but-never-
  //     promoted drafts stay private — promoted_at is the tell.
  //
  // Per-PR kudos credit = direct pr_kudos + issue bounties AWARDED to
  // the PR, the same two-arm union /api/leaderboard/prs uses, so the
  // counts on a profile match the Top PRs tab. Keyset pagination on
  // created_at mirrors GET /api/me/history (`nextBefore` cursor, null
  // when the page came back short).
  // --------------------------------------------------------------
  router.get('/api/leaderboard/users/:username/prs', async (req, res) => {
    const username = req.params.username;
    const limit = clampLimit(req.query.limit === undefined ? '50' : req.query.limit);
    let before = null;
    if (req.query.before !== undefined && req.query.before !== '') {
      const t = Date.parse(req.query.before);
      if (!Number.isFinite(t)) {
        return res.status(400).json({ error: 'Invalid before timestamp' });
      }
      before = new Date(t).toISOString();
    }

    // Shared by the stats aggregate and the page query so the two can
    // never drift. cs/a aliases are bound in both FROM clauses below.
    const proposedFilter = `
          cs.user_id = $1
          AND cs.is_headless = FALSE
          AND a.view_visibility = 'public'
          AND (cs.status IN ('promoted', 'merging', 'merged')
               OR (cs.status = 'archived' AND cs.promoted_at IS NOT NULL))`;
    // The two-arm credit count for one session (direct kudos + awarded
    // bounties) — scalar subqueries keyed on cs.id, no fan-out risk.
    const creditCount = `
          (SELECT COUNT(*) FROM pr_kudos pk WHERE pk.session_id = cs.id)
          + (SELECT COUNT(*) FROM issue_bounties ib
               WHERE ib.status = 'awarded' AND ib.awarded_session_id = cs.id)`;

    try {
      // Resolved through the retired-handle ledger: every
      // #leaderboard/users/<name> link shared before its owner renamed
      // points at a handle `users` no longer carries. The reservation makes
      // the old name unambiguous, so it resolves to the same person and the
      // response carries `moved` so the client can rewrite the hash.
      const resolved = await usernames.resolveHandle(pool, username);
      if (!resolved) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = { id: resolved.userId, username: resolved.username };
      const moved = resolved.retired
        ? { from: username, to: resolved.username }
        : null;

      // Headline stats over the FULL filtered set (pagination-agnostic).
      // kudos_merged matches the leaderboard's headline score
      // (kudos_received_prs_merged above): all awarded bounties are
      // merged credit by construction, direct kudos count only when the
      // PR's status is currently 'merged'.
      const { rows: statRows } = await pool.query(
        `SELECT COUNT(*)::int AS prs_total,
                COUNT(*) FILTER (WHERE cs.status = 'merged')::int AS prs_merged,
                COALESCE(SUM(${creditCount}) FILTER (WHERE cs.status = 'merged'), 0)::int AS kudos_merged
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE ${proposedFilter}`,
        [user.id]
      );

      const params = [user.id];
      let beforeClause = '';
      if (before) {
        params.push(before);
        beforeClause = `AND cs.created_at < $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT cs.id AS session_id,
                cs.pr_number, cs.pr_url, cs.pr_title,
                -- Merged but not live yet (chat_sessions.live_at): the badge says going live.
                CASE WHEN cs.status = 'merged' AND cs.live_at IS NULL THEN 'merging' ELSE cs.status END AS status,
                cs.created_at, cs.promoted_at, cs.merged_at,
                a.slug AS app_slug, a.name AS app_name,
                (${creditCount})::int AS kudos_count
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE ${proposedFilter}
            ${beforeClause}
          ORDER BY cs.created_at DESC
          LIMIT $${params.length}`,
        params
      );

      const nextBefore = rows.length === limit
        ? rows[rows.length - 1].created_at
        : null;
      res.json({
        user: { user_id: user.id, username: user.username },
        stats: statRows[0],
        items: rows,
        nextBefore,
        ...(moved ? { moved } : {}),
      });
    } catch (err) {
      log.error('kudos', 'leaderboard/users/prs failed', { username, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, n));
}

module.exports = {
  kudosRoutes,
  // Exported for tests and for reuse in other modules (e.g. /promoted
  // and /merged extend their queries with kudos counts, but they
  // compute them inline; weekStartUtc is needed to align the
  // server-side "this week" filter with what the FE budget badge
  // shows). WEEKLY_KUDOS_LIMIT is a constant; ELIGIBLE_STATES is the
  // canonical list the FE can use to know when to render the give-
  // kudos button at all. WEEKLY_KUDOS_LIMIT + countWeeklyAllowanceUsed
  // are re-exports from services/bounties.js — same values, same
  // behaviour, so existing importers need no change.
  weekStartUtc,
  countKudosGivenThisWeek,
  countWeeklyAllowanceUsed,
  // #1688: the split allowances, re-exported the same way.
  countWeeklyKudosUsed,
  countWeeklyBountiesUsed,
  WEEKLY_BOUNTY_LIMIT,
  loadKudosForSession,
  WEEKLY_KUDOS_LIMIT,
  ELIGIBLE_STATES,
};
