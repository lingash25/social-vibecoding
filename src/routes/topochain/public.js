// Topochain v4 — public reads (SPEC §4.2, lines 819-832 for the endpoint
// list; 902-1318 for each endpoint's exact contract; 883-895 for the
// §4.8 contract deltas that apply to every one of them).
//
// Mounted in server.js BEFORE authMiddleware (architecture decision #2):
// every route here carries its OWN auth via `optionalSessionAuth`
// (src/middleware/topochain-auth.js) — a valid platform session enriches
// a response (only `/leaderboard/global` branches on `req.user.isAdmin`,
// SPEC 968/988), but no session is required and the request never 401s.
//
// Judgment calls made here where the spec text was ambiguous (documented
// inline at the point of use, flagged again in the task report):
//   1. GET /leaderboard's rank column: SPEC 960 says a REGULAR event's
//      rows are ordered by the event's own stored `rank` column; SPEC
//      2935/2957 says the rank column is "served by the [§4.10] standings
//      query" for season/all-time viewing. Resolved by branching on
//      `season_events.type` (see fetchEventLeaderboardRows below) —
//      'regular' events (the common case) use the stored per-event rank;
//      any other type computes it live via standings.js.
//   2. `identifier` resolution precedence (which of email/telegram/
//      discord backs a user's masked identifier) isn't given a priority
//      order anywhere in the read ranges — email > telegram > discord was
//      chosen as the smallest sensible default (login-identity order).
//   3. `GET /leaderboard/user-activities`'s `participant_identifier` query
//      param is NOT renamed to a `user_*` name — the §8.2/§4.8 rename map
//      only lists `participant_id` (an integer FK), not this identifier
//      string param, so it's kept verbatim per the SPEC request table.
//   4. The v4 "return real zeros instead of null for success rates" rule
//      (task brief) is applied to EVERY success/rate-shaped field built in
//      this file (epoch-breakdown's `success_rate`, challenge-breakdown's
//      `rate`, profile's three rate fields), not only the two fields SPEC
//      962 calls out by name, since the brief states it as a general v4
//      contract requirement.
//   5. Challenge-breakdown's `limit`/`offset` (a NEW endpoint with its own
//      documented pagination shape — `has_more`/`next_offset`, not the
//      shared `meta` envelope, per the "specification wins" prime
//      directive) have no documented error status for an out-of-range
//      value, so they're clamped to the documented default rather than
//      422ing on something the spec never said should error.
//   6. Profile "all-time" mode's `first_block_points`/`top_3_points`/
//      `success_50_percent_points` have no cross-event aggregation rule in
//      §4.10 (only total_points/extra_points/events_participated/
//      produced_blocks are defined there) — reported as 0 in that mode,
//      real per-event values when `season_event_id` is given.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { optionalSessionAuth } = require('../../middleware/topochain-auth');
const { computeStandings } = require('../../services/topochain/standings');
// The per-event standings vocabulary — identifier masking, the display-name
// fallback chain, EVENT_LEADERBOARD_SQL and the type-branch that resolves one
// event's rows — moved into this service when the home screen's Challenges
// widget started previewing the same standings. One definition of a rank and
// one of a display name, shared by the routes and the widget.
const {
  resolveIdentifier, maskIdentifier, resolveDisplayName, fetchEventLeaderboardRows,
  resolveDefaultPublicEvent,
} = require('../../services/topochain/event-standings');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('./helpers');
const { TEMPLATE_JOIN_COLUMNS_SQL, buildChallengeListItem } = require('./challenge-view');
const {
  loadOnboarding, visibleChallenges, challengeCategory, resolveProgress, loadEventBlocks,
} = require('../../services/topochain/challenge-onboarding');
const events = require('../../services/events');

// Fire-and-forget tally behind POST /app-version/check, so the admin screen
// can report whether the release gate is being exercised. `events.record`
// already swallows every failure and always resolves, but this endpoint is
// FULLY PUBLIC and must not grow a failure mode, so the call is additionally
// not awaited and wrapped — nothing here can affect the response.
function recordVersionCheck(pool, os, upgrade) {
  try {
    events.record(pool, {
      type: events.EVENT_TYPES.APP_VERSION_CHECKED,
      metadata: { os, upgrade },
    });
  } catch { /* never let telemetry break a public read */ }
}

// ─── Small shared formatters ─────────────────────────────────────────────

// Path/query param -> positive integer id, or null (malformed / absent).
// Deliberately strict (round-trips through String()) so "5abc" doesn't
// silently become 5 — callers treat null as "not provided" for optional
// params and "not found" for path params.
function toIntId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

// Percentage ratio with the v4 "real zero, never null" rule (judgment
// call #4 above): denominator <= 0 reports 0, not null/NaN. Rounded to
// 2dp to match the NUMERIC(5,2) precision the stored success-rate columns
// already use.
function pct(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

// Same ratio, but null (not 0) when the denominator is zero — SPEC 1286
// is explicit that `client_success_rate`/`canonical_success_rate` on the
// NEW GET /users/{user}/profile endpoint are "null when the denominator
// is zero". That endpoint has no source (v1) behavior to carry a "real
// zero" delta over from, so its own explicit contract wins over the
// general judgment call #4 rule above, which applies everywhere else
// (event_success_rate/epoch_success_rate, epoch-breakdown's success_rate,
// challenge-breakdown's rate all stay real-zero).
function pctOrNull(numerator, denominator) {
  const d = Number(denominator) || 0;
  if (d <= 0) return null;
  return Math.round((Number(numerator) / d) * 10000) / 100;
}

// starts_at/ends_at -> the {has_started, has_ended, status} triple every
// event object in this file carries (SPEC 902's `event` shape).
function eventStatus(startsAt, endsAt, now = new Date()) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const hasStarted = now >= start;
  const hasEnded = now >= end;
  return { hasStarted, hasEnded, status: hasEnded ? 'ended' : (hasStarted ? 'active' : 'upcoming') };
}

// ─── Identifier masking, display names, per-event rows ──────────────────
//
// resolveIdentifier / maskIdentifier / resolveDisplayName (SPEC 958, 1246),
// EVENT_LEADERBOARD_SQL and fetchEventLeaderboardRows all live in
// src/services/topochain/event-standings.js now — see the require at the top
// of this file, and that module's header for why they moved. Their behaviour
// is unchanged; the SQL text is byte-identical.

function formatLeaderboardRow(r) {
  const identifier = resolveIdentifier(r);
  return {
    rank: Number(r.rank),
    is_non_podium: !!r.exclude_podium,
    identifier: maskIdentifier(identifier),
    display_name: resolveDisplayName(r),
    discord: r.discord || null,
    wallet_address: r.wallet_address || null,
    bech32m: r.bech32m || null,
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    bug_report_points: Number(r.bug_report_points) || 0,
    inviting_new_participant_points: Number(r.inviting_new_participant_points) || 0,
    community_contribution_points: Number(r.community_contribution_points) || 0,
    last_epoch_total_produced_blocks: Number(r.last_epoch_total_produced_blocks) || 0,
    event_total_produced_blocks: Number(r.event_total_produced_blocks) || 0,
    vrf_total_won_slots: Number(r.vrf_total_won_slots) || 0,
    canonical_total_won_slots: Number(r.canonical_total_won_slots) || 0,
    canonical_total_produced_blocks: Number(r.canonical_total_produced_blocks) || 0,
    canonical_won_slots_up_to_current: Number(r.canonical_won_slots_up_to_current) || 0,
    canonical_produced_blocks_up_to_current: Number(r.canonical_produced_blocks_up_to_current) || 0,
    max_bp_success_rate_up_to_current: num(r.max_bp_success_rate_up_to_current) ?? 0,
    // SPEC 962: v4 returns the real zero (source returned null-for-falsy).
    event_success_rate: num(r.event_success_rate) ?? 0,
    epoch_success_rate: num(r.epoch_success_rate) ?? 0,
    first_block_points: Number(r.first_block_points) || 0,
    produced_half_blocks_points: Number(r.produced_half_blocks_points) || 0,
    top_3_points: Number(r.top_3_points) || 0,
    success_50_percent_points: Number(r.success_50_percent_points) || 0,
  };
}

// ─── GET /season-events/{event}/challenges: override/effective merge ────
//
// Task 12 lifted this mapping (and the challenge_templates JOIN column
// list) into ./challenge-view.js so admin/challenges.js's own D6 index
// route can return "the same mapped structure" (SPEC 2672) without a
// second, drifting copy of buildChallengeListItem. See that module's
// top-of-file comment for the full rationale.

// ─── Router ───────────────────────────────────────────────────────────

function topochainPublicRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Every route in this group is optionally-authenticated (SPEC 900);
  // applied once here rather than per-route since it never itself
  // produces a response (see the middleware's own doc comment).
  //
  // SCOPED to /api/v4/ (integration-review finding): this router is
  // mounted UNSCOPED at the app root in server.js (`app.use(topochain
  // PublicRoutes(config))`, server.js:443), BEFORE authMiddleware — so a
  // bare `router.use(mw)` would run the middleware for EVERY request that
  // reaches this mount point, including all v1 APIs, static assets and
  // SPA loads. optionalSessionAuth does a `sessions JOIN users` query per
  // request with a session cookie; authMiddleware then repeats the same
  // lookup for the platform routes it guards — a pure duplicate per-
  // request DB cost with no correctness impact. The prefix guard makes
  // this middleware a no-op outside the /api/v4 surface it exists for.
  //
  // The compare is case-INSENSITIVE (`toLowerCase()`), the same idiom as
  // topochain admin.js's read-gate guard: Express 4 matches routes
  // case-insensitively, so `/api/v4/LEADERBOARD` reaches the handlers
  // below and must get the same optional-auth enrichment (an admin's
  // session must still resolve however the path is cased).
  const sessionAuth = optionalSessionAuth(config);
  router.use((req, res, next) => {
    if (!req.path.toLowerCase().startsWith('/api/v4/')) return next();
    return sessionAuth(req, res, next);
  });

  // Mount-order probe (plan Task 3), kept as-is per the Task 5 brief.
  router.get('/api/v4/public/__ping', (_req, res) => ok(res, {}));

  // ── GET /leaderboard (SPEC 902-965) ────────────────────────────────
  router.get('/api/v4/leaderboard', async (req, res) => {
    try {
      // SPEC 912: default per_page is 50 for this endpoint (not this
      // repo's shared 25 default — see the `defaultPerPage` doc comment
      // on `paginate()`).
      const { page, perPage } = paginate(req, { defaultPerPage: 50 }); // may throw ValidationError (422)

      const requestedId = toIntId(req.query.season_event_id);
      let event;
      if (requestedId) {
        const { rows } = await pool.query(
          `SELECT id, name, disclaimer, display_leaderboard, starts_at, ends_at,
                  internal, season_id, type
             FROM season_events WHERE id = $1`,
          [requestedId]
        );
        event = rows[0];
        if (!event || event.internal) return fail(res, 404, 'Event not found.');
      } else {
        // The default event is resolved by the SHARED rule
        // (resolveDefaultPublicEvent, src/services/topochain/
        // event-standings.js) rather than by a strict reading of SPEC 910's
        // "current" (temporally ongoing AND is_active). DO NOT "restore"
        // the strict query — three things depend on this being the shared
        // rule:
        //
        //   1. It is what the season default of issue #999 means. The
        //      shared rule prefers the season's own `type = 'season'`
        //      event, so a caller that asks for "the leaderboard" with no
        //      id gets the whole-season standings, not whichever sub-event
        //      started last.
        //   2. It stops this endpoint 404ing between events — production's
        //      normal state. The client already overrides the strict rule
        //      (public/js/topochain-events.js exists for exactly that), so
        //      the strict answer was only ever visible as a flash of "No
        //      events have been published yet." on first paint, before the
        //      picker's list landed and the pane refetched with an id.
        //   3. The home-screen widget already resolves its board this way
        //      (home-panels.js -> eventStandingsBoard), so the two agreed
        //      on the event only by accident before.
        //
        // The 404 below now means what it says: there is no public event
        // with standings at all.
        event = await resolveDefaultPublicEvent(pool);
        if (event) {
          // resolveDefaultPublicEvent selects the columns its own callers
          // need; this endpoint additionally serializes `disclaimer` /
          // `display_leaderboard`, so re-read the row by id.
          const { rows } = await pool.query(
            `SELECT id, name, disclaimer, display_leaderboard, starts_at, ends_at,
                    internal, season_id, type
               FROM season_events WHERE id = $1`,
            [event.id]
          );
          event = rows[0];
        }
        if (!event) return fail(res, 404, 'No active event found. Please specify a season_event_id.');
      }

      const { hasStarted, hasEnded, status } = eventStatus(event.starts_at, event.ends_at);
      const eventPayload = {
        id: Number(event.id),
        name: event.name,
        disclaimer: event.disclaimer,
        display_leaderboard: event.display_leaderboard,
        starts_at: iso(event.starts_at),
        ends_at: iso(event.ends_at),
        has_started: hasStarted,
        has_ended: hasEnded,
        status,
        // Additive to the v1 shape, for the same reason `display_leaderboard`
        // is additive on /season-events: `type = 'season'` means these rows
        // are the WHOLE season's aggregate (fetchEventLeaderboardRows routes
        // them through computeStandings), so the pane must be able to say so
        // and to drop the per-event-only columns that can only read 0.
        type: event.type,
      };

      // SPEC 961: display_leaderboard=false -> identical envelope, empty
      // list, meta.total 0.
      if (!event.display_leaderboard) {
        return ok(res, { data: { event: eventPayload, leaderboard: [] } }, { meta: meta(page, perPage, 0) });
      }

      const rows = await fetchEventLeaderboardRows(pool, event);
      const total = rows.length;
      const start = (page - 1) * perPage;
      const leaderboard = rows.slice(start, start + perPage).map(formatLeaderboardRow);

      return ok(res, { data: { event: eventPayload, leaderboard } }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-public', 'GET /leaderboard failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /leaderboard/global (SPEC 966-1002; §4.10 kept, standings query) ─
  router.get('/api/v4/leaderboard/global', async (req, res) => {
    try {
      // SPEC 975: default per_page is 50 here too.
      const { page, perPage } = paginate(req, { defaultPerPage: 50 });
      const standings = await computeStandings(pool, { seasonId: null });
      const total = standings.length;
      const start = (page - 1) * perPage;
      const isAdmin = !!(req.user && req.user.isAdmin);

      const leaderboard = standings.slice(start, start + perPage).map((s) => {
        const row = {
          rank: s.rank,
          is_non_podium: s.is_non_podium,
          identifier: maskIdentifier(resolveIdentifier(s)),
          // SPEC 988 makes discord ADMIN ONLY on this endpoint, so the
          // display-name fallback must not leak the raw handle to
          // non-admins either (see resolveDisplayName's doc comment).
          display_name: resolveDisplayName(s, { includeDiscord: isAdmin }),
          total_points: s.total_points,
          events_participated: s.events_participated,
          total_produced_blocks: s.total_produced_blocks,
          // v4 phase->event rename (source: total_produced_blocks_last_phase).
          total_produced_blocks_last_event: s.total_produced_blocks_last_event,
        };
        // SPEC 988: admin-only field, key absent entirely for anon/non-admin.
        if (isAdmin) row.discord = s.discord || null;
        return row;
      });

      return ok(res, { data: { leaderboard } }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-public', 'GET /leaderboard/global failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /leaderboard/epoch-breakdown (SPEC 1009-1051, rebuilt on epoch_stats) ─
  router.get('/api/v4/leaderboard/epoch-breakdown', async (req, res) => {
    try {
      const walletAddress = typeof req.query.wallet_address === 'string' ? req.query.wallet_address.trim() : '';
      if (!walletAddress) return fail(res, 400, 'wallet_address is required.');

      const seasonEventId = toIntId(req.query.season_event_id);
      if (!seasonEventId) return fail(res, 400, 'season_event_id is required.');

      const { rows: eventRows } = await pool.query(
        `SELECT id, name, start_epoch, end_epoch, chain_id, internal, season_id
           FROM season_events WHERE id = $1`,
        [seasonEventId]
      );
      const event = eventRows[0];
      if (!event || event.internal) return fail(res, 404, 'Event not found.');

      const { rows: acctRows } = await pool.query(
        `SELECT address FROM onchain_accounts
          WHERE (public_key = $1 OR address = $1)
            AND (season_event_id = $2 OR (season_event_id IS NULL AND season_id = $3))
          LIMIT 1`,
        [walletAddress, seasonEventId, event.season_id]
      );
      if (!acctRows.length) return fail(res, 404, 'No onchain account found for this wallet in this event.');

      // `epoch_stats.wallet_address` stores only the canonical bech32m
      // `address` form (SPEC: "keyed by ... wallet_address"), never the
      // `public_key` form — but the existence check just above matches
      // EITHER form (SPEC 1017: "matched against the user's account
      // public_key OR address"), since callers may reasonably pass either.
      // A caller who passed the public_key form must not silently get an
      // empty breakdown: resolve to the matched account's own `address`
      // and query epoch_stats with THAT, never the raw request param.
      const canonicalAddress = acctRows[0].address;

      // SPEC 1049: the epoch filter applies only when BOTH bounds are set.
      const params = [event.chain_id, canonicalAddress];
      let epochFilter = '';
      if (event.start_epoch != null && event.end_epoch != null) {
        epochFilter = ' AND epoch BETWEEN $3 AND $4';
        params.push(event.start_epoch, event.end_epoch);
      }
      const { rows } = await pool.query(
        `SELECT epoch, epoch_won_slots AS total_won_slots, epoch_produced_blocks AS chain_total_produced_blocks
           FROM epoch_stats
          WHERE chain_id = $1 AND wallet_address = $2 ${epochFilter}
          ORDER BY epoch ASC`,
        params
      );

      const breakdown = rows.map((r) => {
        const won = Number(r.total_won_slots) || 0;
        const produced = Number(r.chain_total_produced_blocks) || 0;
        return {
          epoch: Number(r.epoch),
          total_won_slots: won,
          chain_total_produced_blocks: produced,
          // SPEC 1048: no `*_up_to_current` split exists in epoch_stats —
          // report the epoch totals for both (judgment call documented
          // at the top of this file).
          won_slots_up_to_current: won,
          chain_produced_blocks_up_to_current: produced,
          success_rate: pct(produced, won),
        };
      });

      return ok(res, {
        data: {
          event: {
            id: Number(event.id),
            name: event.name,
            // start_epoch/end_epoch are BIGINT columns — `pg` returns those
            // as strings (to avoid silent precision loss), so they need the
            // same explicit Number() cast as every other integer column
            // read from a bigint here (SPEC §4.8 item 5's "numbers, not
            // strings" rule, extended to every numeric-looking field).
            start_epoch: event.start_epoch != null ? Number(event.start_epoch) : null,
            end_epoch: event.end_epoch != null ? Number(event.end_epoch) : null,
          },
          breakdown,
        },
      });
    } catch (err) {
      log.error('topochain-public', 'GET /leaderboard/epoch-breakdown failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /leaderboard/user-activities (SPEC 1076-1110, v1 participant-activities) ─
  router.get('/api/v4/leaderboard/user-activities', async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      const identifier = typeof req.query.participant_identifier === 'string'
        ? req.query.participant_identifier.trim() : '';

      const details = {};
      if (!seasonEventId) details.season_event_id = ['The season_event_id field is required.'];
      if (!identifier) details.participant_identifier = ['The participant_identifier field is required.'];
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows: evRows } = await pool.query('SELECT id FROM season_events WHERE id = $1', [seasonEventId]);
      if (!evRows.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }

      // SPEC 1108: email/telegram/discord match, OR any onchain account
      // address equal to the identifier — not scoped to this event.
      //
      // SCOPED TO TOPOCHAIN PARTICIPANTS (security-review finding): this
      // route is public (pre-authMiddleware) and its 404-vs-200 split is
      // an exact-match existence oracle for the identifier. The source
      // system resolved identifiers against its own `participants` table,
      // so "any user" there meant "any competition participant" — but the
      // v4 migration folded participants into the SHARED platform `users`
      // table (Global Constraints #7), which also holds every ordinary
      // platform web account. Without the participant predicate below,
      // this endpoint would confirm/deny the email, telegram or discord
      // handle of EVERY platform account. Requiring at least one
      // user_enrollments row (or, for migrated pre-enrollment data, a
      // leaderboard_snapshots row) preserves the source's real semantics;
      // a non-participant match falls through to the exact same 404 body
      // as an unknown identifier — no distinguishable behavior. The
      // onchain-account branch needs no extra predicate: `onchain_accounts`
      // is itself a topochain-only table, so any user_id it links to is a
      // participant by construction.
      const { rows: userRows } = await pool.query(
        `SELECT u.id FROM users u
          WHERE (u.email = $1 OR u.telegram = $1 OR u.discord = $1)
            AND (EXISTS (SELECT 1 FROM user_enrollments ue WHERE ue.user_id = u.id)
                 OR EXISTS (SELECT 1 FROM leaderboard_snapshots ls WHERE ls.user_id = u.id))
         UNION
         SELECT oa.user_id AS id FROM onchain_accounts oa WHERE oa.address = $1 AND oa.user_id IS NOT NULL
         LIMIT 1`,
        [identifier]
      );
      if (!userRows.length) {
        // SPEC 1104's literal body (not the standard error envelope: an
        // extra `data: []` alongside `error`, no trailing period).
        return res.status(404).json({ success: false, error: 'Participant not found', data: [] });
      }
      const userId = userRows[0].id;

      const { rows } = await pool.query(
        `SELECT id, activity_type, points, description, activity_at, metadata
           FROM user_activities
          WHERE user_id = $1 AND season_event_id = $2
          ORDER BY activity_at DESC`,
        [userId, seasonEventId]
      );

      const data = rows.map((r) => ({
        id: Number(r.id),
        activity_type: r.activity_type,
        points: num(r.points) ?? 0,
        description: r.description,
        activity_at: iso(r.activity_at),
        metadata: r.metadata,
      }));

      return ok(res, { data });
    } catch (err) {
      log.error('topochain-public', 'GET /leaderboard/user-activities failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /season-events (SPEC 1112-1141, v1 /phases) ────────────────
  router.get('/api/v4/season-events', async (req, res) => {
    try {
      const raw = req.query.include_past;
      const truthy = ['1', 'true', 'on', 'yes'];
      const includePast = typeof raw === 'string' && truthy.includes(raw.toLowerCase());

      const where = includePast ? 'internal = FALSE' : 'internal = FALSE AND is_active = TRUE';
      const { rows } = await pool.query(
        `SELECT id, name, description, starts_at, ends_at, start_epoch, end_epoch,
                is_active, display_activities, display_leaderboard, type, season_id
           FROM season_events WHERE ${where} ORDER BY starts_at DESC`
      );

      const now = new Date();
      const data = rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        description: r.description,
        starts_at: iso(r.starts_at),
        ends_at: iso(r.ends_at),
        start_epoch: r.start_epoch != null ? Number(r.start_epoch) : null,
        end_epoch: r.end_epoch != null ? Number(r.end_epoch) : null,
        is_active: r.is_active,
        is_current: new Date(r.starts_at) <= now && now <= new Date(r.ends_at),
        display_activities: r.display_activities,
        // Additive (not in the v1 shape): lets a client pick a default
        // event that will actually render standings instead of landing on
        // one whose leaderboard is switched off and looks empty. See
        // public/js/topochain-events.js#pickDefault.
        display_leaderboard: r.display_leaderboard,
        // Additive for the same reason (issue #999): `type = 'season'`
        // identifies the event whose standings are the WHOLE season's
        // aggregate, which is the dataset pickDefault must prefer and the
        // one the picker should not label "(past)". `season_id` rides along
        // so a client can label the season without a second round trip.
        type: r.type,
        season_id: r.season_id != null ? Number(r.season_id) : null,
      }));

      return ok(res, { data });
    } catch (err) {
      log.error('topochain-public', 'GET /season-events failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /season-events/{event} (SPEC 1142-1160, v1 /phases/{phase}) ─
  router.get('/api/v4/season-events/:seasonEventId', async (req, res) => {
    try {
      const id = toIntId(req.params.seasonEventId);
      if (!id) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query(
        `SELECT id, name, description, starts_at, ends_at, start_epoch, end_epoch,
                is_active, display_activities, internal
           FROM season_events WHERE id = $1`,
        [id]
      );
      const event = rows[0];
      if (!event || event.internal) return fail(res, 404, 'Event not found.');

      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM user_enrollments WHERE season_event_id = $1',
        [id]
      );

      const now = new Date();
      return ok(res, {
        data: {
          id: Number(event.id),
          name: event.name,
          description: event.description,
          starts_at: iso(event.starts_at),
          ends_at: iso(event.ends_at),
          start_epoch: event.start_epoch != null ? Number(event.start_epoch) : null,
          end_epoch: event.end_epoch != null ? Number(event.end_epoch) : null,
          is_active: event.is_active,
          is_current: new Date(event.starts_at) <= now && now <= new Date(event.ends_at),
          display_activities: event.display_activities,
          // v1 participants_count -> v4 users_count (SPEC 1152).
          users_count: countRows[0].c,
        },
      });
    } catch (err) {
      log.error('topochain-public', 'GET /season-events/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /season-events/{event}/challenges (SPEC 1161-1204, v1 .../activities) ─
  router.get('/api/v4/season-events/:seasonEventId/challenges', async (req, res) => {
    try {
      const id = toIntId(req.params.seasonEventId);
      if (!id) return fail(res, 404, 'Event not found.');

      const { rows: evRows } = await pool.query('SELECT id, internal FROM season_events WHERE id = $1', [id]);
      const event = evRows[0];
      if (!event || event.internal) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query(
        // `c.completed` is the organiser's "this challenge is over" flag.
        // The `c.enabled = TRUE` filter below deliberately does NOT exclude
        // it — a finished challenge is still an enabled row and still
        // belongs in the list; the flag rides along so the client can group
        // and count them (buildChallengeListItem publishes it).
        `SELECT c.id, c.season_event_id, c.challenge_template_id, c.enabled,
                c.completed,
                c.goal, c.task, c.reward, c.description, c.requirements,
                c.schedule_start, c.schedule_end, c.reward_logic,
                c.cta_button, c.cta_label, c.cta_link,
                c.metric_type, c.metric_target, c.metric_label,
                ${TEMPLATE_JOIN_COLUMNS_SQL},
                ck.icon AS kind_icon
           FROM challenges c
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
           -- #1914: the card's picture, from the KIND the challenge resolves
           -- to (its own override, else its template's) — the same join and
           -- the same COALESCE Home's panel query uses, so a challenge wears
           -- one face on both surfaces. Null for a kind that is unset or has
           -- no icon, which the tile falls back from rather than drawing a
           -- blank square.
           LEFT JOIN challenge_kinds ck ON ck.id = COALESCE(c.kind, ct.kind)
          WHERE c.season_event_id = $1 AND c.enabled = TRUE
          ORDER BY c.display_order ASC, c.id ASC`,
        [id]
      );
      // The EFFECTIVE metric — the challenge row's override over the
      // template's, the same merge Home's panel and /challenges-api apply.
      // `activity_type` is the template alone by contract, so the challenge
      // card would otherwise count toward a target the organiser overrode.
      const eff = (r, key) => (r[key] != null ? r[key] : r[`t_${key}`]);
      const metricOf = (r) => {
        const kind = eff(r, 'metric_type');
        if (!kind) return null;
        const target = eff(r, 'metric_target');
        return { kind, target: target == null ? null : Number(target), label: eff(r, 'metric_label') ?? null };
      };

      // SPEC 1197: the source 500s on a deleted activity type; guard by
      // skipping any row whose template join came back empty instead
      // (the FK itself should make this unreachable in practice — see the
      // schema.sql comment on `challenges.challenge_template_id`).
      const onboarding = await loadOnboarding(pool, req.user?.id, { eventId: id });
      const listed = rows.filter((r) => r.t_id != null);
      const visible = visibleChallenges(listed, onboarding);

      // The viewer's own credit count per challenge.
      //
      // This list used to carry progress for the ONBOARDING rows alone,
      // because they were the only challenges anything credited without an
      // admin typing it in. The card's `_isDone` reads `progress.done` off
      // THIS payload, so every other challenge fell through to "is there any
      // activity" and showed "Started" — permanently, even to somebody who
      // had finished it and been paid for it. Automatic scoring
      // (services/topochain/challenge-scorer.js) makes that the normal state
      // of four of the nine Season 2 challenges, so the same rule now covers
      // all of them.
      //
      // One grouped count for the whole list rather than a query per card,
      // and only for a signed-in viewer — the anonymous list has no progress
      // to report and must not pay for a query to say so.
      const counts = new Map();
      if (req.user?.id && visible.length) {
        const { rows: countRows } = await pool.query(
          `SELECT challenge_id, COUNT(*)::int AS credits
             FROM user_activities
            WHERE user_id = $1 AND challenge_id = ANY($2::bigint[])
            GROUP BY challenge_id`,
          [req.user.id, visible.map((r) => Number(r.id))]
        );
        for (const row of countRows) counts.set(Number(row.challenge_id), Number(row.credits));
      }

      // And the viewer's block count, for the same reason (#2492). It cannot
      // come from the ledger — block scores are only ever written to
      // leaderboard snapshots — so the row used to carry no progress at all
      // for a `blocks_produced` challenge and its card drew a ring with no
      // words beside it, while Home, which reads the snapshot, showed the
      // real count. One query for the whole list, and only when the list
      // actually holds such a card.
      const wantsBlocks = visible.some((r) => metricOf(r)?.kind === 'blocks_produced');
      const blocksByEvent = wantsBlocks && req.user?.id
        ? await loadEventBlocks(pool, req.user.id, [id])
        : new Map();

      const data = visible
        .map((r) => {
          const item = buildChallengeListItem(r);
          item.metric = metricOf(r);
          const category = challengeCategory(item.id, item.activity_type.category, onboarding);
          item.activity_type.category = category;
          item.card_preview.label = (category || '').toUpperCase();
          if (onboarding?.progress.has(item.id)) {
            item.progress = onboarding.progress.get(item.id);
          } else if (req.user?.id) {
            // `blocks_produced` is in this now (#2492). Its count is the
            // viewer's newest snapshot rather than a ledger row count, which
            // is the one thing resolveProgress needs told; everything else —
            // the done rule, the clamp, the target — is the rule every other
            // metric goes through, so the tab and Home print one number.
            item.progress = resolveProgress({
              metricKind: item.metric ? item.metric.kind : null,
              metricTarget: item.metric ? item.metric.target : null,
              activityCount: counts.get(Number(item.id)) || 0,
              blocks: blocksByEvent.get(Number(item.season_event_id)),
            });
          }
          return item;
        });

      // This list now carries the signed-in viewer's onboarding state. While
      // the gate is closed it also says how many of THIS event's challenges
      // it hides (additive `hidden_count`, the tab's "N challenges locked"
      // placeholder); unlocked, the summary is exactly what it was.
      const summary = onboarding && !onboarding.summary.unlocked
        ? { ...onboarding.summary, hidden_count: listed.length - visible.length }
        : onboarding?.summary;
      res.set('Cache-Control', 'private, no-store');
      return ok(res, { data, ...(summary ? { onboarding: summary } : {}) });
    } catch (err) {
      log.error('topochain-public', 'GET /season-events/:id/challenges failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /season-events/{event}/challenges/{challenge}/breakdown — NEW ─
  // (SPEC 1205-1247)
  router.get('/api/v4/season-events/:seasonEventId/challenges/:challengeId/breakdown', async (req, res) => {
    try {
      const eventId = toIntId(req.params.seasonEventId);
      const challengeId = toIntId(req.params.challengeId);
      if (!eventId || !challengeId) return fail(res, 404, 'Challenge not found.');

      const { rows: cRows } = await pool.query(
        `SELECT c.id, c.season_event_id, c.goal AS c_goal, c.kind AS c_kind,
                ct.category AS t_category, ct.goal AS t_goal, ct.kind AS t_kind,
                ct.metric_type AS t_metric_type
           FROM challenges c
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE c.id = $1 AND c.season_event_id = $2`,
        [challengeId, eventId]
      );
      const row = cRows[0];
      if (!row) return fail(res, 404, 'Challenge not found.');

      // Judgment call: challenge_templates has no "is this block
      // production" flag; the fixture data (schema.sql / migrate.js
      // seedStagingTopochain) marks the one block-production template
      // with metric_type='blocks_produced', so that's the signal used —
      // `kind` alone is not distinctive here (the block-production
      // template reuses the same kind as the plain send-transaction one).
      const isProduceBlocks = row.t_metric_type === 'blocks_produced';

      const challenge = {
        id: Number(row.id),
        goal: row.c_goal != null ? row.c_goal : row.t_goal,
        category: row.t_category,
        kind: row.c_kind != null ? row.c_kind : row.t_kind,
        season_event_id: Number(row.season_event_id),
        is_produce_blocks: isProduceBlocks,
      };

      // limit/offset (judgment call #5): clamp silently to the documented
      // 1..100 / >=0 bounds rather than 422ing on something the spec
      // never assigns an error status to.
      let limit = 50;
      const rawLimit = parseInt(req.query.limit, 10);
      if (Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100) limit = rawLimit;
      let offset = 0;
      const rawOffset = parseInt(req.query.offset, 10);
      if (Number.isInteger(rawOffset) && rawOffset >= 0) offset = rawOffset;

      const { rows: totalsRows } = await pool.query(
        `SELECT COUNT(DISTINCT user_id)::int AS participants, COALESCE(SUM(points), 0) AS total_points
           FROM user_activities WHERE challenge_id = $1`,
        [challengeId]
      );
      const totals = {
        participants: totalsRows[0].participants,
        total_points: num(totalsRows[0].total_points) ?? 0,
      };

      // Fetch one extra row to know whether more remain beyond this page.
      const { rows: entryRows } = await pool.query(
        `SELECT ua.user_id, SUM(ua.points) AS points, u.discord, u.display_name,
                u.email, u.telegram, u.username, u.exclude_podium, ls.event_success_rate
           FROM user_activities ua
           JOIN users u ON u.id = ua.user_id
           LEFT JOIN LATERAL (
             SELECT event_success_rate FROM leaderboard_snapshots
              WHERE season_event_id = $2 AND user_id = ua.user_id
              ORDER BY snapshot_at DESC, id DESC LIMIT 1
           ) ls ON TRUE
          WHERE ua.challenge_id = $1
          GROUP BY ua.user_id, u.discord, u.display_name, u.email, u.telegram,
                   u.username, u.exclude_podium, ls.event_success_rate
          ORDER BY SUM(ua.points) DESC
          LIMIT $3 OFFSET $4`,
        [challengeId, eventId, limit + 1, offset]
      );

      const hasMore = entryRows.length > limit;
      const entries = entryRows.slice(0, limit).map((r) => ({
        user_id: Number(r.user_id),
        display_name: resolveDisplayName(r),
        is_non_podium: !!r.exclude_podium,
        points: num(r.points) ?? 0,
        rate: isProduceBlocks ? (num(r.event_success_rate) ?? 0) : null,
      }));

      return ok(res, {
        data: {
          challenge,
          totals,
          entries,
          has_more: hasMore,
          // SPEC's own example shows next_offset = offset + limit even
          // when has_more is false, so it's unconditional here too.
          next_offset: offset + limit,
        },
      });
    } catch (err) {
      log.error('topochain-public', 'GET challenge breakdown failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /users/{user}/profile — NEW (SPEC 1249-1287) ────────────────
  router.get('/api/v4/users/:userId/profile', async (req, res) => {
    try {
      const userId = toIntId(req.params.userId);
      if (!userId) return fail(res, 404, 'User not found.');

      // SCOPED TO TOPOCHAIN PARTICIPANTS (security-review finding, same
      // reasoning as /leaderboard/user-activities above): this public
      // route enumerates by sequential integer id, and the shared platform
      // `users` table (Global Constraints #7) holds every platform web
      // account, not just competition participants. The source system's
      // profile lookups ran against its own `participants` table, so the
      // participant predicate here (an enrollment, or a snapshot for
      // migrated pre-enrollment data) preserves that intent; a
      // non-participant id returns this exact same 404 as an unknown id.
      const { rows: userRows } = await pool.query(
        `SELECT u.id, u.email, u.telegram, u.discord, u.display_name, u.username
           FROM users u
          WHERE u.id = $1
            AND (EXISTS (SELECT 1 FROM user_enrollments ue WHERE ue.user_id = u.id)
                 OR EXISTS (SELECT 1 FROM leaderboard_snapshots ls WHERE ls.user_id = u.id))`,
        [userId]
      );
      const user = userRows[0];
      if (!user) return fail(res, 404, 'User not found.');

      const identifierType = resolveIdentifier(user).type;
      const displayName = resolveDisplayName(user);
      const seasonEventId = toIntId(req.query.season_event_id);

      if (seasonEventId) {
        const { rows: evRows } = await pool.query(
          'SELECT id, internal, season_id FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        const event = evRows[0];
        if (!event || event.internal) return fail(res, 404, 'Event not found.');

        const { rows: snapRows } = await pool.query(
          `SELECT * FROM leaderboard_snapshots
            WHERE season_event_id = $1 AND user_id = $2
            ORDER BY snapshot_at DESC, id DESC LIMIT 1`,
          [seasonEventId, userId]
        );
        const snap = snapRows[0] || null;

        const { rows: acctRows } = await pool.query(
          `SELECT public_key FROM onchain_accounts
            WHERE user_id = $1
              AND (season_event_id = $2 OR (season_event_id IS NULL AND season_id = $3))
            ORDER BY (season_event_id IS NULL) ASC, id DESC LIMIT 1`,
          [userId, seasonEventId, event.season_id]
        );

        const { rows: activityRows } = await pool.query(
          `SELECT id, challenge_id, activity_type, points, description, activity_at
             FROM user_activities WHERE user_id = $1 AND season_event_id = $2
            ORDER BY activity_at DESC`,
          [userId, seasonEventId]
        );

        // SPEC 1286: null (not real-zero) when the denominator is zero —
        // see pctOrNull's doc comment.
        const clientSuccessRate = snap ? pctOrNull(snap.event_total_produced_blocks, snap.vrf_total_won_slots) : null;
        const canonicalSuccessRate = snap
          ? pctOrNull(snap.canonical_total_produced_blocks, snap.canonical_total_won_slots) : null;

        return ok(res, {
          data: {
            display_name: displayName,
            identifier_type: identifierType,
            wallet_address: acctRows[0]?.public_key || null,
            rank: snap ? Number(snap.rank) : null,
            total_points: snap ? (num(snap.total_points) ?? 0) : 0,
            extra_points: snap ? (num(snap.extra_points) ?? 0) : 0,
            first_block_points: snap ? Number(snap.first_block_points) || 0 : 0,
            top_3_points: snap ? Number(snap.top_3_points) || 0 : 0,
            success_50_percent_points: snap ? Number(snap.success_50_percent_points) || 0 : 0,
            vrf_won_slots: snap ? Number(snap.vrf_total_won_slots) || 0 : 0,
            canonical_won_slots: snap ? Number(snap.canonical_total_won_slots) || 0 : 0,
            produced_blocks: snap ? Number(snap.event_total_produced_blocks) || 0 : 0,
            canonical_produced_blocks: snap ? Number(snap.canonical_total_produced_blocks) || 0 : 0,
            client_success_rate: clientSuccessRate,
            canonical_success_rate: canonicalSuccessRate,
            success_rate: snap ? (num(snap.event_success_rate) ?? 0) : 0,
            challenge_details: (snap && snap.challenge_details) || {},
            activities: activityRows.map((a) => ({
              activity_id: Number(a.id),
              challenge_id: Number(a.challenge_id),
              activity_type: a.activity_type,
              points: num(a.points) ?? 0,
              description: a.description,
              activity_at: iso(a.activity_at),
            })),
          },
        });
      }

      // All-time mode (SPEC 1285): the §4.10 shared aggregate supplies
      // rank/total_points/extra_points; everything else that aggregate
      // doesn't carry is summed here, over the same "latest snapshot per
      // public event" rule, scoped to this one user (judgment call #6 for
      // the three fields with no defined cross-event rule at all).
      const standings = await computeStandings(pool, { seasonId: null });
      const own = standings.find((s) => s.user_id === userId) || null;

      const { rows: extraRows } = await pool.query(
        `SELECT ls.vrf_total_won_slots, ls.canonical_total_won_slots,
                ls.canonical_total_produced_blocks, ls.event_total_produced_blocks,
                ls.event_success_rate
           FROM (
             SELECT DISTINCT ON (season_event_id) *
               FROM leaderboard_snapshots
              WHERE user_id = $1
              ORDER BY season_event_id, snapshot_at DESC, id DESC
           ) ls
           JOIN season_events se ON se.id = ls.season_event_id
          WHERE se.internal = FALSE`,
        [userId]
      );
      const sum = (key) => extraRows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
      const vrfWonSlots = sum('vrf_total_won_slots');
      const canonicalWonSlots = sum('canonical_total_won_slots');
      const canonicalProducedBlocks = sum('canonical_total_produced_blocks');
      const producedBlocks = sum('event_total_produced_blocks');
      const meanSuccessRate = extraRows.length
        ? extraRows.reduce((acc, r) => acc + (num(r.event_success_rate) ?? 0), 0) / extraRows.length
        : 0;

      const { rows: acctRows2 } = await pool.query(
        'SELECT public_key FROM onchain_accounts WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [userId]
      );
      const { rows: activityRows2 } = await pool.query(
        `SELECT id, challenge_id, activity_type, points, description, activity_at
           FROM user_activities WHERE user_id = $1 ORDER BY activity_at DESC`,
        [userId]
      );

      return ok(res, {
        data: {
          display_name: displayName,
          identifier_type: identifierType,
          wallet_address: acctRows2[0]?.public_key || null,
          rank: own ? own.rank : null,
          total_points: own ? own.total_points : 0,
          extra_points: own ? own.extra_points : 0,
          first_block_points: 0,
          top_3_points: 0,
          success_50_percent_points: 0,
          vrf_won_slots: vrfWonSlots,
          canonical_won_slots: canonicalWonSlots,
          produced_blocks: producedBlocks,
          canonical_produced_blocks: canonicalProducedBlocks,
          // SPEC 1286: null (not real-zero) when the denominator is zero.
          client_success_rate: pctOrNull(producedBlocks, vrfWonSlots),
          canonical_success_rate: pctOrNull(canonicalProducedBlocks, canonicalWonSlots),
          success_rate: meanSuccessRate,
          challenge_details: {},
          activities: activityRows2.map((a) => ({
            activity_id: Number(a.id),
            challenge_id: Number(a.challenge_id),
            activity_type: a.activity_type,
            points: num(a.points) ?? 0,
            description: a.description,
            activity_at: iso(a.activity_at),
          })),
        },
      });
    } catch (err) {
      log.error('topochain-public', 'GET /users/:id/profile failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /app-version/check (SPEC 1289-1318, fully public) ─────────
  router.post('/api/v4/app-version/check', async (req, res) => {
    try {
      const body = req.body || {};
      const details = {};

      const os = body.os;
      if (os !== 'ios' && os !== 'android') {
        details.os = ['The os field must be one of: ios, android.'];
      }
      const appVersion = body.app_version;
      if (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > 50) {
        details.app_version = ['The app_version field is required and must be a string of at most 50 characters.'];
      }
      const buildNumber = Number(body.build_number);
      if (!Number.isInteger(buildNumber) || buildNumber < 1) {
        details.build_number = ['The build_number field must be an integer of at least 1.'];
      }
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `SELECT min_build_number, recommended_build_number, must_update_message,
                should_update_message, update_url
           FROM app_version_configs WHERE os = $1 AND is_active = TRUE LIMIT 1`,
        [os]
      );
      const versionConfig = rows[0];

      // SPEC 1318: v4 always returns all three keys, even with no config row.
      if (!versionConfig) {
        recordVersionCheck(pool, os, 0);
        return ok(res, { data: { upgrade: 0, details: null, update_url: null } });
      }

      let upgrade = 0;
      if (buildNumber < versionConfig.min_build_number) upgrade = 2;
      else if (versionConfig.recommended_build_number != null && buildNumber < versionConfig.recommended_build_number) upgrade = 1;

      let upgradeDetails = null;
      if (upgrade === 2) {
        upgradeDetails = versionConfig.must_update_message
          || 'A required update is available. Please update the app to continue.';
      } else if (upgrade === 1) {
        upgradeDetails = versionConfig.should_update_message
          || 'A new version is available. We recommend updating.';
      }

      const updateUrl = upgrade === 0 ? null : (versionConfig.update_url || null);

      recordVersionCheck(pool, os, upgrade);
      return ok(res, { data: { upgrade, details: upgradeDetails, update_url: updateUrl } });
    } catch (err) {
      log.error('topochain-public', 'POST /app-version/check failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { topochainPublicRoutes };
