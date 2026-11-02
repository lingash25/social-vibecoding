'use strict';

// Errors that should not happen, kept where admins see them (#4210). A bot
// build a restart or a lost worker cut short is picked up again on its own,
// and its person is not told when it carries on from its plan, so without a
// record here nobody would know how often it happens. Each incident is one
// `events` row (event_type 'platform_incident', its kind in the metadata),
// listed in the Homeroom bot console's Rollout health panel (recent) and in
// the admin console's Unexpected events section (list, #4296), which
// services/platform-incident-alerts.js also reads for its digest and its
// once-an-hour alert.
// Written by the platform, never from what a person typed: `why` is one of
// the platform's own reasons ("the worker is gone"), so the rows hold
// nothing private.

const events = require('./events');
const log = require('./logger');

const TYPE = events.EVENT_TYPES.PLATFORM_INCIDENT;

const KINDS = Object.freeze({
  BUILD_INTERRUPTED: 'build_interrupted',
  // A change's red check that the bot's fix turn found is not the change's
  // doing (it fails without it too): the checks' own problem, which only
  // admins can fix (homeroom-bot.js runChecksFix).
  CHECKS_NOT_CHANGE: 'checks_not_change',
  // Homeroom bot parity P6: each step of working past such a check as a
  // person would (homeroom-bot-flaky-checks.js): synced, filed or found its
  // fix, building, rechecking, green or person (detail.outcome).
  CHECKS_FIXING_FLAKE: 'checks_fixing_flake',
});

// How far back the console looks, and how many it lists.
const RECENT_DAYS = 7;
const RECENT_LIMIT = 20;

/** Record one incident. Never throws; resolves when it is written (or skipped). */
function record(pool, { kind, appId = null, sessionId = null, detail = {} } = {}) {
  if (!kind) return Promise.resolve();
  return events.record(pool, {
    type: TYPE,
    appId: appId == null ? null : Number(appId),
    sessionId: sessionId == null ? null : Number(sessionId),
    metadata: { ...detail, kind },
  });
}

/**
 * How many times a build of this run was interrupted and carried on from its
 * plan (outcome 'resumed') in the last `hours`. A resume keeps its run, so
 * the count of runs sent back (homeroom-bot.js restartedBuildsBefore) does
 * not see them. 0 when it cannot be read.
 */
async function resumesOfRun(pool, runId, { hours = 24 } = {}) {
  try {
    const { rows: [row] = [] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND created_at > NOW() - make_interval(hours => $2)
          AND metadata->>'kind' = $3 AND metadata->>'runId' = $4 AND metadata->>'outcome' = 'resumed'`,
      [TYPE, hours, KINDS.BUILD_INTERRUPTED, String(Number(runId))],
    );
    return Number(row?.n) || 0;
  } catch (err) {
    log.warn('platform-incidents', 'Could not count a run\'s resumed builds', { runId, err: err.message });
    return 0;
  }
}

/**
 * The latest incidents, newest first, for the admin console:
 * { days, total, items: [{ at, kind, app, runId, issueNumber, why, outcome }] }.
 * Null when they cannot be read.
 */
async function recent(pool, { days = RECENT_DAYS, limit = RECENT_LIMIT } = {}) {
  try {
    const [{ rows }, { rows: [count] = [] }] = await Promise.all([
      pool.query(
        `SELECT e.created_at, e.metadata, a.slug AS app_slug
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE e.event_type = $1 AND e.created_at > NOW() - make_interval(days => $2)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $3`,
        [TYPE, days, limit],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM events
          WHERE event_type = $1 AND created_at > NOW() - make_interval(days => $2)`,
        [TYPE, days],
      ),
    ]);
    return {
      days,
      total: Number(count?.n) || rows.length,
      items: rows.map((r) => {
        const m = r.metadata || {};
        return {
          at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          kind: String(m.kind || 'unknown'),
          app: r.app_slug || null,
          runId: Number.isFinite(Number(m.runId)) && m.runId != null ? Number(m.runId) : null,
          issueNumber: Number.isFinite(Number(m.issueNumber)) && m.issueNumber != null ? Number(m.issueNumber) : null,
          why: m.why ? String(m.why).slice(0, 300) : null,
          outcome: m.outcome ? String(m.outcome) : null,
        };
      }),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not read recent incidents', { err: err.message });
    return null;
  }
}

// #4296: the Unexpected events section. How far back it can look, and how
// many rows one read lists.
const LIST_DAYS = Object.freeze([1, 7, 30]);
const LIST_LIMIT = 100;
const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function listDays(days) {
  const n = Number(days);
  return LIST_DAYS.includes(n) ? n : RECENT_DAYS;
}

function idOrNull(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : null;
}

/**
 * Every incident in the last `days` (1, 7 or 30), newest first, filtered by
 * kind and app slug when given, for the admin console's Unexpected events
 * section (#4296):
 *
 *   { days, kind, app, total, items: [{ at, kind, app, sessionId, runId,
 *     issueNumber, why, outcome }], daily: [{ day, kind, n }],
 *     kinds: [{ kind, n }], apps: [slug] }
 *
 * `daily` counts the filtered rows per UTC day and kind; `kinds` and `apps`
 * are the window's choices for the two filters, unfiltered, so picking one
 * does not hide the others. A filter that is not a plausible kind or slug is
 * ignored. Null when they cannot be read.
 */
async function list(pool, { days, kind = null, app = null, limit = LIST_LIMIT } = {}) {
  const span = listDays(days);
  const k = typeof kind === 'string' && KIND_RE.test(kind) ? kind : null;
  const slug = typeof app === 'string' && SLUG_RE.test(app) ? app : null;
  const cap = Math.max(1, Math.min(LIST_LIMIT, Number(limit) || LIST_LIMIT));
  const where = `e.event_type = $1 AND e.created_at > NOW() - make_interval(days => $2)
            AND ($3::text IS NULL OR e.metadata->>'kind' = $3)
            AND ($4::text IS NULL OR a.slug = $4)`;
  const params = [TYPE, span, k, slug];
  try {
    const [{ rows }, { rows: daily }, { rows: kinds }, { rows: apps }] = await Promise.all([
      pool.query(
        `SELECT e.created_at, e.session_id, e.metadata, a.slug AS app_slug
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE ${where}
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $5`,
        [...params, cap],
      ),
      pool.query(
        `SELECT to_char(date_trunc('day', e.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                COALESCE(e.metadata->>'kind', 'unknown') AS kind, COUNT(*)::int AS n
           FROM events e LEFT JOIN apps a ON a.id = e.app_id
          WHERE ${where}
          GROUP BY 1, 2
          ORDER BY 1 DESC, 2`,
        params,
      ),
      pool.query(
        `SELECT COALESCE(metadata->>'kind', 'unknown') AS kind, COUNT(*)::int AS n
           FROM events
          WHERE event_type = $1 AND created_at > NOW() - make_interval(days => $2)
          GROUP BY 1
          ORDER BY 2 DESC, 1`,
        [TYPE, span],
      ),
      pool.query(
        `SELECT DISTINCT a.slug
           FROM events e JOIN apps a ON a.id = e.app_id
          WHERE e.event_type = $1 AND e.created_at > NOW() - make_interval(days => $2)
          ORDER BY a.slug
          LIMIT 200`,
        [TYPE, span],
      ),
    ]);
    const counted = daily.map((r) => ({ day: String(r.day), kind: String(r.kind), n: Number(r.n) || 0 }));
    return {
      days: span,
      kind: k,
      app: slug,
      total: counted.reduce((sum, r) => sum + r.n, 0),
      items: rows.map((r) => {
        const m = r.metadata || {};
        return {
          at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          kind: String(m.kind || 'unknown'),
          app: r.app_slug || null,
          sessionId: idOrNull(r.session_id),
          runId: idOrNull(m.runId),
          issueNumber: idOrNull(m.issueNumber),
          why: m.why ? String(m.why).slice(0, 300) : null,
          outcome: m.outcome ? String(m.outcome).slice(0, 40) : null,
        };
      }),
      daily: counted,
      kinds: kinds.map((r) => ({ kind: String(r.kind), n: Number(r.n) || 0 })),
      apps: apps.map((r) => String(r.slug)),
    };
  } catch (err) {
    log.warn('platform-incidents', 'Could not list incidents', { err: err.message });
    return null;
  }
}

/**
 * How many incidents of each kind were recorded in [since, until), most
 * first: [{ kind, n }]. What the alerts count (platform-incident-alerts.js).
 * Throws, unlike the reads above: the alert sweep reports its own errors.
 */
async function countByKind(pool, { since, until = null }) {
  const { rows } = await pool.query(
    `SELECT COALESCE(metadata->>'kind', 'unknown') AS kind, COUNT(*)::int AS n
       FROM events
      WHERE event_type = $1 AND created_at >= $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      GROUP BY 1
      ORDER BY 2 DESC, 1`,
    [TYPE, since, until],
  );
  return rows.map((r) => ({ kind: String(r.kind), n: Number(r.n) || 0 }));
}

module.exports = {
  KINDS, RECENT_DAYS, LIST_DAYS, LIST_LIMIT,
  record, resumesOfRun, recent, list, countByKind,
};
