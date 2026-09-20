// Topochain v4 — authenticated mobile data surface (SPEC §4.5).
//
// Mounted in server.js BEFORE authMiddleware: protocol-2 native session
// establishment privately mints the bearer consumed here. The raw bearer is
// never exposed to Social JavaScript, and participant identity always comes
// from that credential.
//
// Task 3 built the mount-order probe below. Task 9 added the five first-render data
// endpoints: GET /me, /me/ranking, /me/breakdown, /event/points,
// /leaderboard (SPEC 1748-1932; 883-895 for the §4.8 contract deltas;
// 2936-2959 for the standings reuse + challenge-progress placeholder
// ruling). Task 10 (this task) adds the rest: GET /challenges, GET
// /seasons and POST /zkpassport/complete (SPEC 1934-2191; 2939 +
// 2961-2973 for the zkpassport metadata/replay-index resolution). Its own
// judgment calls and rename decisions are documented at each route below
// rather than repeated here, EXCEPT one that spans the whole file: the
// challenge override-merge key set (`MOBILE_OVERRIDE_KEYS` below) is
// DELIBERATELY wider than public.js's own `OVERRIDE_KEYS` for a different
// SPEC endpoint group — see the comment on `MOBILE_OVERRIDE_KEYS`.
//
// ── Rename decisions applied in this file (§4.8 rule 1 + §8.2 map) ──────
//   1. Every mobile `event_id` param/key becomes `season_event_id` — SPEC
//      883 calls this out by name ("the mobile API already speaks in
//      events, but its event_id parameters and keys become season_event_id
//      too"). Applied to GET /event/points's `data.event_id` (SPEC 1884
//      literal) and GET /leaderboard's `event_id` query param (SPEC 1900).
//   2. `participant_total_points` (SPEC 1884) -> `user_total_points`: the
//      §8.2 map lists `participant_id` -> `user_id` and
//      `participant_totals` -> `user_totals`; neither is a literal string
//      match for this key, but it is unambiguously a `participant_*`
//      reference key, so the same rename direction applies here per the
//      task brief's explicit instruction. Its VALUE is documented at the
//      route below (a judgment call: the source computes this identically
//      to `event_total_points`, so v4 keeps them equal rather than
//      inventing a second, undocumented aggregate).
//   3. `sub_category` -> `kind` (§8.2, SPEC 324/379): breakdown's
//      `activity_sub_category` (SPEC 1849) is the OLD serializer's name for
//      a challenge's `sub_category` (now `challenge_templates.kind`)
//      joined onto each activity row — so the JSON key becomes
//      `activity_kind` here, carrying the challenge's `kind` value.
'use strict';

const { nativeWebSessionIsLive } = require('../../services/web-session-auth');


const {
  loadOnboarding, visibleChallenges, challengeCategory, resolveProgress, loadEventBlocks,
} = require('../../services/topochain/challenge-onboarding');

const { Router } = require('express');
const bcrypt = require('bcrypt');
const { clientIp } = require('../../services/client-ip');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth, optionalSessionAuth } = require('../../middleware/topochain-auth');
const { mobileWalletClaimLimiter } = require('../../middleware/rate-limits');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('./helpers');
const { computeStandings, assignSharedRanks } = require('../../services/topochain/standings');
const { resolveDisplayName } = require('../../services/topochain/event-standings');
const { nativeSessionRoutes } = require('./native-session');
const { nativeEpochDelegationRoutes } = require('./epoch-delegation');
const { mobileIdentityHash } = require('../../services/mobile-identity-hash');
const { mobilePushRegistrationRoutes } = require('./mobile-push-registration');
const { verifyCompletion, ZkBridgeError } = require('../../services/topochain/zk-bridge');

// ─── Small shared formatters (duplicated in miniature from public.js — ──
// that file doesn't export its identifier/display-name helpers, and these
// are small enough pure functions that re-deriving them locally beats
// wiring a cross-route-module dependency for a handful of one-liners).

// Path/query param -> positive integer id, or null (malformed/absent) —
// same convention as public.js's toIntId: null means "not provided" for
// an optional param.
function toIntId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

async function computeLevel(pool, userId, passwordSet) {
  const { rows } = await pool.query(
    'SELECT 1 FROM onchain_accounts WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (rows.length) return 'operator';
  return passwordSet ? 'member' : 'guest';
}

// `include_activity` (breakdown) — bool query param, default TRUE (SPEC
// 1826). Only an explicit falsy string turns it off; anything else
// (including garbage) keeps the SPEC default.
function parseBoolDefaultTrue(raw) {
  if (raw === undefined) return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
}

// The mirror image, for the several Task 10 params whose SPEC default is
// `false` (GET /challenges's active_only/only_scheduled; GET /seasons's
// only_active_seasons/only_current_season/include_internal_seasons/
// only_active_events/only_current_events/include_internal_events). Only an
// explicit truthy string turns it on; anything else (including garbage)
// keeps the SPEC default of false.
function parseBoolDefaultFalse(raw) {
  if (raw === undefined) return false;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

const WALLET_CLAIM_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WALLET_CLAIM_MAX_OTP_ATTEMPTS = 5;

function walletClaimEmail(rawEmail) {
  if (typeof rawEmail !== 'string') return null;
  const email = rawEmail.trim().toLowerCase();
  return email.length <= 255 && WALLET_CLAIM_EMAIL_RE.test(email) ? email : null;
}

// Same "real zero, never null" success-rate convention public.js documents
// (judgment call #4 there) — mobile leaderboard's SEASON scope computes
// `success_rate` live from summed won/produced slots (SPEC 1928: "Season
// scope computes success_rate from won/produced slots").
function pctLocal(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return Math.round((n / d) * 10000) / 100;
}

// The display-name chain (discord -> display_name -> masked identifier ->
// platform username; SPEC 1859 for breakdown's `display_name`, also used for
// leaderboard rows) is the shared one in services/topochain/event-standings.js.
// This file kept its own copy until #2394, and the copy is how a fix to the
// public board would have skipped the mobile one.

// ─── Terms gate (SPEC 1791/2957: un-gates /me/ranking's total_tokens) ───
//
// "Current published terms" = the terms_versions row with the latest
// published_at (published_at IS NOT NULL). No published version at all ->
// gate open (SPEC 1791's "if no terms version is published the gate is
// open") — modeled here as termsAccepted: true with both other fields
// null, so a caller's `if (!terms_accepted) tokens = 0` short-circuits
// correctly without a special case at every call site.
async function getTermsGate(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, version, terms_link FROM terms_versions
      WHERE published_at IS NOT NULL
      ORDER BY published_at DESC, id DESC LIMIT 1`
  );
  const current = rows[0];
  if (!current) {
    return { termsAccepted: true, termsVersionRequired: null, termsLink: null };
  }
  const { rows: consentRows } = await pool.query(
    'SELECT status FROM user_terms_consents WHERE user_id = $1 AND terms_version_id = $2',
    [userId, current.id]
  );
  const accepted = consentRows.length > 0 && consentRows[0].status === 'accepted';
  return { termsAccepted: accepted, termsVersionRequired: current.version, termsLink: current.terms_link };
}

// ─── Token totals (token_allocation — SPEC 504-526, staging:private) ───
//
// "total_tokens" reads `token_allocation.allocated_tokens` (the amount
// actually allocated TO this user), not `total_season_tokens` (the
// season-wide pool total) — a judgment call, since SPEC's ranking block
// only names the response key, not which token_allocation column backs
// it; `allocated_tokens` is the only per-user token quantity the table
// carries. Querying a user's OWN allocation row is not the kind of bulk
// exposure the table's staging:private classification guards against.
async function sumSeasonTokens(pool, userId, seasonId) {
  const { rows } = await pool.query(
    'SELECT allocated_tokens FROM token_allocation WHERE user_id = $1 AND season_id = $2',
    [userId, seasonId]
  );
  return rows.length ? (num(rows[0].allocated_tokens) ?? 0) : 0;
}

// Global scope: summed across every season the user has an allocation in,
// restricted to public (non-internal) seasons — mirrors the standings
// query's own internal-season exclusion.
async function sumAllTokens(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(ta.allocated_tokens), 0) AS total
       FROM token_allocation ta
       JOIN seasons s ON s.id = ta.season_id
      WHERE ta.user_id = $1 AND s.internal = FALSE`,
    [userId]
  );
  return num(rows[0].total) ?? 0;
}

// ─── /me/breakdown building blocks (SPEC 1821-1865) ─────────────────────

async function fetchEventSnapshot(pool, userId, eventId) {
  const { rows } = await pool.query(
    `SELECT rank, total_points, extra_points, first_block_points, top_3_points,
            success_50_percent_points, event_total_produced_blocks,
            vrf_total_won_slots, event_success_rate
       FROM leaderboard_snapshots
      WHERE season_event_id = $1 AND user_id = $2
      ORDER BY snapshot_at DESC, id DESC LIMIT 1`,
    [eventId, userId]
  );
  return rows[0] || null;
}

// `challenge_progress` covers every ENABLED challenge in the event (SPEC
// 1863), zero-filled per the §4.10 placeholder ruling (state "none",
// current null, pending_points 0) — earned_points is the one real field,
// summed from user_activities. `target` reads `challenge_templates
// .metric_target` only (never merged with `challenges.metric_target`) —
// following the same precedent public.js documents for `kind`/`metric_*`/
// friends: those columns exist on `challenges` too but are, by that
// file's own established judgment call, "excluded from the override set
// ... they come straight off the template, never the challenge row".
// `description` DOES merge (challenges row overrides the template, same
// as public.js's OVERRIDE_KEYS list).
async function fetchChallengeProgress(pool, userId, eventId) {
  const { rows: challenges } = await pool.query(
    `SELECT c.id, c.description AS c_description, ct.description AS t_description, ct.metric_target
       FROM challenges c
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE c.season_event_id = $1 AND c.enabled = TRUE
      ORDER BY c.display_order ASC, c.id ASC`,
    [eventId]
  );
  if (!challenges.length) return [];

  const ids = challenges.map((c) => Number(c.id));
  const { rows: earnedRows } = await pool.query(
    `SELECT challenge_id, COALESCE(SUM(points), 0) AS earned
       FROM user_activities
      WHERE user_id = $1 AND challenge_id = ANY($2::bigint[])
      GROUP BY challenge_id`,
    [userId, ids]
  );
  const earnedMap = new Map(earnedRows.map((r) => [Number(r.challenge_id), num(r.earned) ?? 0]));

  return challenges.map((c) => ({
    challenge_id: Number(c.id),
    // §4.10 placeholder ruling (SPEC 2955-2957): nothing populates these
    // three yet — return the literal placeholders, not computed values.
    state: 'none',
    current: null,
    target: num(c.metric_target),
    pending_points: 0,
    earned_points: earnedMap.get(Number(c.id)) || 0,
    description: c.c_description != null ? c.c_description : c.t_description,
  }));
}

// `activities[]` entries (SPEC 1849), only when include_activity. Rename
// #3 above: `activity_sub_category` -> `activity_kind`, sourced from the
// activity's own challenge's template `kind` (INNER JOIN is safe here —
// user_activities.challenge_id CASCADEs with its challenge row, so no
// activity can outlive the challenge it points at).
async function fetchBreakdownActivities(pool, userId, eventId) {
  const { rows } = await pool.query(
    `SELECT ua.id, ua.challenge_id, ua.activity_type, ua.points, ua.description, ua.activity_at,
            ct.kind AS activity_kind
       FROM user_activities ua
       JOIN challenges c ON c.id = ua.challenge_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE ua.user_id = $1 AND ua.season_event_id = $2
      ORDER BY ua.activity_at DESC`,
    [userId, eventId]
  );
  return rows.map((r) => ({
    activity_id: Number(r.id),
    challenge_id: Number(r.challenge_id),
    activity_type: r.activity_type,
    activity_kind: r.activity_kind,
    points: num(r.points) ?? 0,
    description: r.description,
    activity_at: iso(r.activity_at),
  }));
}

// Builds one "event object" (SPEC 1833-1848's event-scope shape), reused
// verbatim as an item of `events[]` (season scope) / `seasons[].events[]`
// (global scope). `omitBonusKeys` drops first_block_points/top_3_points/
// success_50_percent_points entirely — SPEC 1855: global scope's nested
// event objects omit those three, season scope's don't.
//
// v4 zero-fill delta (SPEC 1862): the source only carries total_points/
// extra_points/rank when no snapshot exists for this (user, event); v4
// zero-fills every other key instead of omitting them. `hasSnapshot` is
// returned alongside so the two list-building call sites (season/global)
// can implement the OTHER SPEC 1865 rule — "events/seasons without a
// snapshot are skipped" — by dropping the object rather than including a
// zero-filled placeholder. The single, DIRECT event-scope response (this
// same builder, called once) always keeps its object and zero-fills,
// mirroring /me/ranking's own "no data still 200, zeroed" rule.
async function buildEventBreakdown(pool, userId, event, { includeActivity, omitBonusKeys }) {
  const snap = await fetchEventSnapshot(pool, userId, event.id);

  const obj = {
    event: { id: Number(event.id), name: event.name },
    total_points: snap ? (num(snap.total_points) ?? 0) : 0,
    extra_points: snap ? (num(snap.extra_points) ?? 0) : 0,
    rank: snap ? Number(snap.rank) : null,
  };
  if (!omitBonusKeys) {
    obj.first_block_points = snap ? Number(snap.first_block_points) || 0 : 0;
    obj.top_3_points = snap ? Number(snap.top_3_points) || 0 : 0;
    obj.success_50_percent_points = snap ? Number(snap.success_50_percent_points) || 0 : 0;
  }
  obj.produced_blocks = snap ? Number(snap.event_total_produced_blocks) || 0 : 0;
  obj.vrf_won_slots = snap ? Number(snap.vrf_total_won_slots) || 0 : 0;
  obj.success_rate = snap ? (num(snap.event_success_rate) ?? 0) : 0;
  obj.challenge_progress = await fetchChallengeProgress(pool, userId, event.id);
  if (includeActivity) obj.activities = await fetchBreakdownActivities(pool, userId, event.id);

  return { obj, hasSnapshot: !!snap };
}

// ─── Mobile leaderboard building blocks (SPEC 1895-1932) ────────────────

// Event scope (SPEC 1929: "event scope uses the stored snapshot rank and
// omits events_participated") — the same "latest snapshot per user for
// one event" shape public.js's EVENT_LEADERBOARD_SQL uses, trimmed to the
// columns this endpoint's row shape needs.
async function fetchEventScopeLeaderboard(pool, eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (ls.user_id) ls.user_id, ls.rank, ls.total_points, ls.extra_points,
              ls.event_total_produced_blocks AS total_produced_blocks, ls.vrf_total_won_slots,
              ls.event_success_rate, u.exclude_podium AS is_non_podium, u.email, u.telegram,
              u.discord, u.display_name, u.username
         FROM leaderboard_snapshots ls
         JOIN users u ON u.id = ls.user_id
        WHERE ls.season_event_id = $1
        ORDER BY ls.user_id, ls.snapshot_at DESC, ls.id DESC
     ) latest
     ORDER BY latest.rank ASC`,
    [eventId]
  );
  return rows.map((r) => ({
    user_id: Number(r.user_id),
    rank: Number(r.rank),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    vrf_total_won_slots: Number(r.vrf_total_won_slots) || 0,
    event_success_rate: num(r.event_success_rate) ?? 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
    username: r.username,
  }));
}

// Season scope. This is a SEPARATE aggregate from services/topochain/
// standings.js's shared §4.10 query, not a reuse of it — that query's
// four columns (total_points, extra_points, events_participated,
// total_produced_blocks) don't include `vrf_total_won_slots`, which this
// endpoint's row shape needs to compute `success_rate` (SPEC 1928: "from
// won/produced slots"). It DOES reuse the shared-rank algorithm
// (`assignSharedRanks`, exported by standings.js) rather than
// re-implementing podium-exclusion — only the SQL aggregate itself is
// extended, per the task brief's "reuse standings.js for the global
// scope" (this is the mobile LEADERBOARD's season scope, a different
// endpoint from /me/ranking, hence the separate query).
//
// Code review fix: `se.display_leaderboard = TRUE` is required here, not
// just `se.internal = FALSE` — the `events[]` list on this same endpoint
// (built a few lines below in the router) already filters
// `display_leaderboard = TRUE`, and a hidden event's points/blocks/slots
// must not silently leak into the season-wide totals of an event that
// isn't shown anywhere. Without this, an event an operator hid from the
// leaderboard mid-event would still move every user's season rank.
const SEASON_LEADERBOARD_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.season_event_id, ls.user_id)
           ls.user_id, ls.season_event_id, ls.total_points, ls.extra_points,
           ls.event_total_produced_blocks, ls.vrf_total_won_slots
      FROM leaderboard_snapshots ls
      JOIN season_events se ON se.id = ls.season_event_id
     WHERE se.internal = FALSE AND se.display_leaderboard = TRUE AND se.season_id = $1
     ORDER BY ls.season_event_id, ls.user_id, ls.snapshot_at DESC, ls.id DESC
  )
  SELECT l.user_id,
         SUM(l.total_points) AS total_points,
         SUM(l.extra_points) AS extra_points,
         COUNT(DISTINCT l.season_event_id) AS events_participated,
         SUM(l.event_total_produced_blocks) AS total_produced_blocks,
         SUM(l.vrf_total_won_slots) AS vrf_total_won_slots,
         u.exclude_podium AS is_non_podium, u.email, u.telegram, u.discord, u.display_name,
         u.username
    FROM latest l
    JOIN users u ON u.id = l.user_id
   GROUP BY l.user_id, u.exclude_podium, u.email, u.telegram, u.discord, u.display_name,
            u.username
   ORDER BY SUM(l.total_points) DESC, l.user_id ASC
`;

async function fetchSeasonScopeLeaderboard(pool, seasonId) {
  const { rows } = await pool.query(SEASON_LEADERBOARD_SQL, [seasonId]);
  const cast = rows.map((r) => ({
    user_id: Number(r.user_id),
    total_points: num(r.total_points) ?? 0,
    extra_points: num(r.extra_points) ?? 0,
    events_participated: Number(r.events_participated) || 0,
    total_produced_blocks: Number(r.total_produced_blocks) || 0,
    vrf_total_won_slots: Number(r.vrf_total_won_slots) || 0,
    is_non_podium: !!r.is_non_podium,
    email: r.email,
    telegram: r.telegram,
    discord: r.discord,
    display_name: r.display_name,
    username: r.username,
  }));
  return assignSharedRanks(cast);
}

// SPEC 1917 row shape, minus the SEASON-only `events_participated` key
// (event scope omits it entirely — SPEC 1929).
function formatMobileLeaderboardRow(r, isSeasonScope) {
  const row = {
    rank: r.rank == null ? null : Number(r.rank),
    total_points: r.total_points,
    extra_points: r.extra_points,
  };
  if (isSeasonScope) row.events_participated = r.events_participated;
  row.total_produced_blocks = r.total_produced_blocks;
  row.vrf_total_won_slots = r.vrf_total_won_slots;
  row.success_rate = isSeasonScope ? pctLocal(r.total_produced_blocks, r.vrf_total_won_slots) : r.event_success_rate;
  row.user_id = r.user_id;
  row.is_non_podium = r.is_non_podium;
  row.display_name = resolveDisplayName(r);
  return row;
}

// ─── Challenge effective-override merge (SPEC 1934-2029, Task 10) ──────
//
// public.js's `OVERRIDE_KEYS` (its own GET /season-events/{id}/challenges
// endpoint, a DIFFERENT SPEC group) deliberately excludes `kind`/
// `cta_type`/`mobile_cta_*`/`metric_*` from the override set — a
// documented judgment call for THAT endpoint. This task's brief is
// explicit that mobile /challenges and /seasons want the generic
// "override ?? template" rule applied to every field the two tables
// share, `kind` included (challenges.kind really can override
// challenge_templates.kind per the table's own migration note: "an
// instance ... overriding whatever fields it needs" — SPEC's
// `phase_available_activities` table comment), so this is a DIFFERENT,
// wider key set for this file's own two endpoints rather than a reuse of
// public.js's narrower one.
const MOBILE_OVERRIDE_KEYS = [
  'goal', 'task', 'reward', 'description', 'requirements', 'reward_logic',
  'cta_type', 'cta_label', 'cta_link',
  'mobile_cta_type', 'mobile_cta_label', 'mobile_cta_link',
  'kind', 'metric_type', 'metric_target', 'metric_label',
];
const MOBILE_DATE_KEYS = new Set(['schedule_start', 'schedule_end']);
const MOBILE_ALL_OVERRIDE_KEYS = [...MOBILE_OVERRIDE_KEYS, 'schedule_start', 'schedule_end'];

// `r` is a joined challenges+challenge_templates row, template columns
// aliased `t_<col>` (see the two SELECTs below). Returns a flat map of
// EFFECTIVE (challenge override ?? template) values, raw (not yet
// iso()'d for the date keys, not yet num()'d for metric_target) so each
// call site finishes formatting the one or two fields it actually needs.
function buildEffective(r) {
  const eff = {};
  for (const key of MOBILE_ALL_OVERRIDE_KEYS) {
    const challengeVal = r[key];
    const templateVal = r[`t_${key}`];
    eff[key] = challengeVal != null ? challengeVal : templateVal;
  }
  return eff;
}

// §4.8 "v4 standardizes on one" (SPEC 1976-2029's own note that /challenges
// uppercases category but /seasons didn't): v4 uppercases everywhere, with
// "OTHER" for a missing/empty category — applied identically by both
// endpoints below.
function effectiveCategory(rawCategory) {
  return (rawCategory || 'OTHER').toUpperCase();
}

// SPEC 1974's note: "cta_label falls back to 'Get Started' here but not in
// /seasons ... v4 should pick one behavior" — v4's ONE behavior is this
// fallback applied on BOTH endpoints, documented here at the one shared
// call site both builders below go through.
function effectiveCtaLabel(rawCtaLabel) {
  return rawCtaLabel != null ? rawCtaLabel : 'Get Started';
}

// Full per-challenge item for GET /challenges (SPEC 1934-1974): every
// field the response lists, incl. `metric` (null unless configured) and
// the caller-supplied `activities`/`activities_total` (the DB query for
// those runs once for the whole list — see the route below — so they're
// passed in rather than fetched per-row here).
function buildMobileChallengeItem(r, { activities, activitiesTotal }) {
  const eff = buildEffective(r);
  const metricKind = eff.metric_type;
  return {
    id: Number(r.id),
    season_event_id: Number(r.season_event_id),
    event_name: r.event_name,
    event_type: r.event_type,
    category: effectiveCategory(r.t_category),
    kind: eff.kind,
    goal: eff.goal,
    task: eff.task,
    reward: eff.reward,
    metric: metricKind == null ? null : {
      kind: metricKind,
      label: eff.metric_label,
      target: num(eff.metric_target),
    },
    description: eff.description,
    requirements: eff.requirements,
    reward_logic: eff.reward_logic,
    cta_type: eff.cta_type,
    cta_label: effectiveCtaLabel(eff.cta_label),
    cta_link: eff.cta_link,
    mobile_cta_type: eff.mobile_cta_type,
    mobile_cta_label: eff.mobile_cta_label,
    mobile_cta_link: eff.mobile_cta_link,
    schedule_start: iso(eff.schedule_start),
    schedule_end: iso(eff.schedule_end),
    enabled: r.enabled,
    completed: r.completed,
    display_order: Number(r.display_order),
    featured: r.featured,
    featured_order: r.featured_order == null ? null : Number(r.featured_order),
    activities,
    activities_total: activitiesTotal,
  };
}

// Compact per-challenge item for GET /seasons's nested `events[].challenges`
// / `season_challenges` (SPEC 1976-2029's response block): no `metric`, no
// `activities`, no `display_order`/`featured`/`featured_order` — those
// keys simply aren't in this endpoint's documented shape.
function buildSeasonChallengeItem(r) {
  const eff = buildEffective(r);
  return {
    challenge_id: Number(r.id),
    category: effectiveCategory(r.t_category),
    kind: eff.kind,
    goal: eff.goal,
    task: eff.task,
    reward: eff.reward,
    description: eff.description,
    requirements: eff.requirements,
    reward_logic: eff.reward_logic,
    cta_type: eff.cta_type,
    cta_label: effectiveCtaLabel(eff.cta_label),
    cta_link: eff.cta_link,
    mobile_cta_type: eff.mobile_cta_type,
    mobile_cta_label: eff.mobile_cta_label,
    mobile_cta_link: eff.mobile_cta_link,
    schedule_start: iso(eff.schedule_start),
    schedule_end: iso(eff.schedule_end),
    enabled: r.enabled,
    completed: r.completed,
  };
}

// Shared column list both challenge queries below select (event scope and
// season scope differ only in their WHERE clause) — one JOIN shape, kept
// as a template literal fragment so the two call sites can't drift.
const MOBILE_CHALLENGE_COLUMNS = `
  c.id, c.season_event_id, se.name AS event_name, se.type AS event_type,
  c.goal, c.task, c.reward, c.description, c.requirements,
  c.schedule_start, c.schedule_end, c.reward_logic,
  c.cta_type, c.cta_label, c.cta_link,
  c.mobile_cta_type, c.mobile_cta_label, c.mobile_cta_link,
  c.kind, c.metric_type, c.metric_target, c.metric_label,
  c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
  ct.id AS t_id, ct.category AS t_category,
  ct.goal AS t_goal, ct.task AS t_task, ct.reward AS t_reward,
  ct.description AS t_description, ct.requirements AS t_requirements,
  ct.schedule_start AS t_schedule_start, ct.schedule_end AS t_schedule_end,
  ct.reward_logic AS t_reward_logic,
  ct.cta_type AS t_cta_type, ct.cta_label AS t_cta_label, ct.cta_link AS t_cta_link,
  ct.mobile_cta_type AS t_mobile_cta_type, ct.mobile_cta_label AS t_mobile_cta_label,
  ct.mobile_cta_link AS t_mobile_cta_link,
  ct.kind AS t_kind, ct.metric_type AS t_metric_type, ct.metric_target AS t_metric_target,
  ct.metric_label AS t_metric_label
`;

// GET /challenges's event scope (SPEC: "event_id ... takes precedence") —
// every challenge under one event, regardless of the event's own
// internal flag (SPEC's error table for this endpoint lists exactly one
// 404, "Season not found." — nothing about events — so a direct
// season_event_id scope is deliberately NOT internal-filtered here; see
// the route's own comment for the fuller reasoning).
async function fetchChallengesForEvent(pool, seasonEventId) {
  const { rows } = await pool.query(
    `SELECT ${MOBILE_CHALLENGE_COLUMNS}
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE c.season_event_id = $1
      ORDER BY c.display_order ASC, c.id ASC`,
    [seasonEventId]
  );
  return rows.filter((r) => r.t_id != null);
}

// GET /challenges's season scope (explicit season_id, or the "current
// active public season" fallback) — every challenge across every
// non-internal event in that season.
async function fetchChallengesForSeason(pool, seasonId) {
  const { rows } = await pool.query(
    `SELECT ${MOBILE_CHALLENGE_COLUMNS}
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE se.season_id = $1 AND se.internal = FALSE
      ORDER BY c.display_order ASC, c.id ASC`,
    [seasonId]
  );
  return rows.filter((r) => r.t_id != null);
}

// GET /challenges's own `activities[]`/`activities_total` (the calling
// user's own completions of each in-scope challenge) — one query for the
// whole list, grouped in JS per challenge_id by the route below.
async function fetchOwnChallengeActivities(pool, userId, challengeIds) {
  const { rows } = await pool.query(
    `SELECT challenge_id, points, description, activity_at
       FROM user_activities
      WHERE user_id = $1 AND challenge_id = ANY($2::bigint[])
      ORDER BY activity_at DESC`,
    [userId, challengeIds]
  );
  return rows.map((r) => ({ ...r, challenge_id: Number(r.challenge_id) }));
}

// ─── GET /seasons building blocks (SPEC 1976-2029) ──────────────────────

// One event's `challenges[]` (nested inside GET /seasons — a DIFFERENT
// query shape from fetchChallengesForEvent above, since this one applies
// the endpoint's own three challenge-level filters instead of returning
// every challenge unconditionally).
async function fetchSeasonEventChallengeItems(pool, seasonEventId, opts) {
  const { includeCompletedChallenges, onlyEnabledChallenges, challengeCategory: categoryFilter,
    onboarding } = opts;
  const conds = ['c.season_event_id = $1'];
  const params = [seasonEventId];
  if (onlyEnabledChallenges) conds.push('c.enabled = TRUE');
  if (!includeCompletedChallenges) conds.push('c.completed = FALSE');

  const { rows } = await pool.query(
    `SELECT ${MOBILE_CHALLENGE_COLUMNS}
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.display_order ASC, c.id ASC`,
    params
  );
  return visibleChallenges(rows.filter((r) => r.t_id != null), onboarding)
    .map((r) => {
      const item = buildSeasonChallengeItem(r);
      item.category = challengeCategory(item.challenge_id, item.category, onboarding);
      return item;
    })
    .filter((item) => !categoryFilter || item.category.toUpperCase() === categoryFilter.toUpperCase());
}

// One season's `events[]` (each carrying its own `challenges[]` when
// `include_challenges` is set) — events ordered oldest first (SPEC:
// "events oldest first", opposite of the season-level "newest first").
async function fetchSeasonEventsWithChallenges(pool, seasonId, opts) {
  const {
    seasonEventIdParam, onlyActiveEvents, onlyCurrentEvents, includeInternalEvents,
    includeChallenges, includeCompletedChallenges, onlyEnabledChallenges, challengeCategory,
    onboarding,
  } = opts;

  const conds = ['season_id = $1'];
  const params = [seasonId];
  if (seasonEventIdParam) { params.push(seasonEventIdParam); conds.push(`id = $${params.length}`); }
  if (!includeInternalEvents) conds.push('internal = FALSE');
  if (onlyActiveEvents) conds.push('is_active = TRUE');
  if (onlyCurrentEvents) conds.push('starts_at <= NOW() AND ends_at >= NOW()');

  const { rows: eventRows } = await pool.query(
    `SELECT id, type, name, description, starts_at, ends_at, is_active
       FROM season_events
      WHERE ${conds.join(' AND ')}
      ORDER BY starts_at ASC, id ASC`,
    params
  );

  const events = [];
  for (const ev of eventRows) {
    const eventObj = {
      season_event_id: Number(ev.id),
      type: ev.type,
      name: ev.name,
      description: ev.description,
      starts_at: iso(ev.starts_at),
      ends_at: iso(ev.ends_at),
      is_active: ev.is_active,
    };
    if (includeChallenges) {
      // eslint-disable-next-line no-await-in-loop -- fixture-scale lists;
      // sequential keeps the query count obvious (matches this file's own
      // /me/breakdown precedent for the same shape of nested loop).
      eventObj.challenges = await fetchSeasonEventChallengeItems(pool, ev.id, {
        includeCompletedChallenges, onlyEnabledChallenges, challengeCategory, onboarding,
      });
    }
    events.push(eventObj);
  }
  return events;
}

// ─── Router ───────────────────────────────────────────────────────────

function topochainMobileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // mobileTokenAuth — it exists only to prove this router sits ahead of
  // authMiddleware; the real per-route auth lives on each endpoint below.
  router.get('/api/v4/mobile/__ping', (_req, res) => ok(res, {}));

  router.use(nativeSessionRoutes(config));
  router.use(nativeEpochDelegationRoutes(config));
  router.use(mobilePushRegistrationRoutes(config));

  // ── GET /me (SPEC 1748-1767) ─────────────────────────────────────────
  router.get('/api/v4/mobile/me', mobileTokenAuth(config), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, email, display_name, email_confirmed, is_in_waitlist, github, x, password_set,
                is_admin, has_platform_access, bp_requested_at, bp_released_at
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      const user = rows[0];
      // The token resolved to a real row a moment ago (mobileTokenAuth's
      // own JOIN would have failed otherwise) — a row missing here would
      // mean the user was deleted between that lookup and this one; fail
      // closed as the same 401 a dead token gets, rather than a 500.
      if (!user) return fail(res, 401, 'Unauthenticated.');

      const level = await computeLevel(pool, user.id, !!user.password_set);
      return ok(res, {
        data: {
          id: Number(user.id),
          email: user.email,
          display_name: user.display_name,
          email_confirmed: !!user.email_confirmed,
          is_in_waitlist: !!user.is_in_waitlist,
          github: user.github,
          x: user.x,
          level,
          // Onboarding flow alignment. `has_platform_access` mirrors the
          // web gate; `bp_released` is what the mobile app's node gates
          // block production on (bp_requested surfaces "request pending"
          // in the SV settings UI). Admins implicitly have access.
          has_platform_access: !!user.has_platform_access || !!user.is_admin,
          bp_requested: !!user.bp_requested_at,
          bp_released: !!user.bp_released_at,
          // The stable account namespace used by legacy mobile `/me`
          // consumers. Protocol 2 derives the same fact inside its server
          // exchange rather than through a split bridge login call. Stable
          // for the life of the account — see
          // src/services/mobile-identity-hash.js.
          identity_hash: mobileIdentityHash(user),
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── Block-producer queue (onboarding flow alignment) ─────────────────
  // "Ask to participate in block production." Sets bp_requested_at
  // (idempotent — asking twice keeps the original request time) and
  // queues the user for an admin's manual key release (bp_released_at,
  // set from the admin BP queue). Any authenticated account may ask;
  // the SV settings UI only shows the button once the account has
  // platform access, but the server doesn't hard-require it — an admin
  // releasing the request implies approval either way. Hoisted function
  // declarations so the /challenges-api web routes below can share them.
  async function bpStateHandler(req, res) {
    try {
      const { rows } = await pool.query(
        `SELECT is_admin, has_platform_access, bp_requested_at, bp_released_at
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      if (!rows.length) return fail(res, 401, 'Unauthenticated.');
      const u = rows[0];
      return ok(res, {
        data: {
          has_platform_access: !!u.has_platform_access || !!u.is_admin,
          bp_requested: !!u.bp_requested_at,
          bp_released: !!u.bp_released_at,
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET bp/state failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }

  async function bpRequestHandler(req, res) {
    try {
      const { rows } = await pool.query(
        `UPDATE users
            SET bp_requested_at = COALESCE(bp_requested_at, NOW())
          WHERE id = $1
          RETURNING bp_requested_at, bp_released_at`,
        [req.user.id]
      );
      if (!rows.length) return fail(res, 401, 'Unauthenticated.');
      return ok(res, {
        data: {
          bp_requested: true,
          bp_released: !!rows[0].bp_released_at,
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'POST bp/request failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }

  // ── GET /me/ranking (SPEC 1769-1820) ─────────────────────────────────
  // Scope resolution: season_event_id > season_id > neither (global) —
  // SPEC 1774's "takes precedence over season_id".
  // Named handler (not inline) so the /challenges-api web registrations
  // at the bottom of this factory can reuse it with session auth.
  const meRankingHandler = async (req, res) => {
    try {
      // `req.user.id` comes from the credential-bound mobile identity (BIGINT) —
      // node-postgres returns BIGINT columns as STRINGS (no custom type
      // parser is configured in src/db/pool.js), while computeStandings()
      // below Number()-casts its own `user_id` column. Casting once here
      // keeps every later `===` comparison (`standings.find(...)`)
      // correct against a real database, not just this file's mock-pool
      // tests (whose fixtures happen to store ids as JS numbers already).
      const userId = Number(req.user.id);
      const seasonEventId = toIntId(req.query.season_event_id);
      const seasonIdParam = toIntId(req.query.season_id);
      const termsGate = await getTermsGate(pool, userId);
      const termsFields = {
        terms_accepted: termsGate.termsAccepted,
        terms_version_required: termsGate.termsVersionRequired,
        terms_link: termsGate.termsLink,
      };

      if (seasonEventId) {
        const { rows } = await pool.query(
          'SELECT id, name, internal, display_leaderboard FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        const event = rows[0];
        if (!event) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal || !event.display_leaderboard) {
          return fail(res, 404, 'Event not found or has no leaderboard.');
        }

        const snap = await fetchEventSnapshot(pool, userId, event.id);
        const { rows: countRows } = await pool.query(
          'SELECT COUNT(DISTINCT user_id)::int AS c FROM leaderboard_snapshots WHERE season_event_id = $1',
          [event.id]
        );

        const data = {
          scope: 'event',
          season_event_id: Number(event.id),
          event_name: event.name,
          rank: snap ? Number(snap.rank) : null,
          total_points: snap ? (num(snap.total_points) ?? 0) : 0,
          // SPEC 1783: hardcoded 0 in event scope, regardless of the
          // terms gate (the gate would force it to 0 anyway).
          total_tokens: 0,
          total_participants: countRows[0].c,
          ...termsFields,
        };
        // SPEC 1784: omitted entirely (not zero) when no snapshot exists.
        if (snap) data.extra_points = num(snap.extra_points) ?? 0;
        return ok(res, { data });
      }

      if (seasonIdParam) {
        const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonIdParam]);
        const season = rows[0];
        if (!season) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_id: ['The selected season_id is invalid.'] },
          });
        }
        if (season.internal) return fail(res, 404, 'Season not found.');

        // Season scope reuses the shared §4.10 aggregate too (not just
        // global) — computeStandings already accepts a seasonId filter,
        // so there's no separate query to write; SPEC's "three
        // consumers" list for this aggregate doesn't name this exact
        // call site, but it's the identical shape with a season filter.
        const standings = await computeStandings(pool, { seasonId: season.id });
        const own = standings.find((s) => s.user_id === userId) || null;
        const totalTokens = termsGate.termsAccepted ? await sumSeasonTokens(pool, userId, season.id) : 0;

        return ok(res, {
          data: {
            scope: 'season',
            season_id: Number(season.id),
            season_name: season.name,
            rank: own ? own.rank : null,
            total_points: own ? own.total_points : 0,
            total_tokens: totalTokens,
            extra_points: own ? own.extra_points : 0,
            total_participants: standings.length,
            ...termsFields,
          },
        });
      }

      // Global scope (SPEC 1798-1805; §4.10's third listed consumer).
      const standings = await computeStandings(pool, { seasonId: null });
      const own = standings.find((s) => s.user_id === userId) || null;
      const totalTokens = termsGate.termsAccepted ? await sumAllTokens(pool, userId) : 0;

      return ok(res, {
        data: {
          scope: 'global',
          rank: own ? own.rank : null,
          total_points: own ? own.total_points : 0,
          total_tokens: totalTokens,
          events_participated: own ? own.events_participated : 0,
          total_produced_blocks: own ? own.total_produced_blocks : 0,
          total_participants: standings.length,
          ...termsFields,
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me/ranking failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };
  router.get('/api/v4/mobile/me/ranking', mobileTokenAuth(config), meRankingHandler);

  // ── GET /me/breakdown (SPEC 1821-1865) ───────────────────────────────
  const meBreakdownHandler = async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      const seasonIdParam = toIntId(req.query.season_id);
      const includeActivity = parseBoolDefaultTrue(req.query.include_activity);

      const { rows: userRows } = await pool.query(
        'SELECT discord, display_name, email, telegram, username FROM users WHERE id = $1',
        [req.user.id]
      );
      const displayName = resolveDisplayName(userRows[0] || {});

      if (seasonEventId) {
        const { rows } = await pool.query(
          'SELECT id, name, internal, display_leaderboard FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        const event = rows[0];
        if (!event) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal || !event.display_leaderboard) {
          return fail(res, 404, 'Event not found or has no leaderboard.');
        }

        const { obj } = await buildEventBreakdown(pool, req.user.id, event, {
          includeActivity, omitBonusKeys: false,
        });
        return ok(res, { data: { display_name: displayName, scope: 'event', ...obj } });
      }

      if (seasonIdParam) {
        const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonIdParam]);
        const season = rows[0];
        if (!season) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_id: ['The selected season_id is invalid.'] },
          });
        }
        if (season.internal) return fail(res, 404, 'Season not found.');

        const { rows: eventRows } = await pool.query(
          'SELECT id, name FROM season_events WHERE season_id = $1 AND internal = FALSE ORDER BY starts_at ASC',
          [season.id]
        );
        const events = [];
        for (const eventRow of eventRows) {
          // eslint-disable-next-line no-await-in-loop -- small per-user
          // fixture-scale lists; sequential keeps the query count obvious.
          const { obj, hasSnapshot } = await buildEventBreakdown(pool, req.user.id, eventRow, {
            includeActivity, omitBonusKeys: false,
          });
          // SPEC 1865: events without a snapshot are skipped, not
          // returned zero-filled (that zero-fill only applies to the
          // single direct event-scope response above).
          if (hasSnapshot) events.push(obj);
        }
        return ok(res, { data: { display_name: displayName, scope: 'season', events } });
      }

      // Global scope: seasons[].events[], events omit the three bonus
      // keys (SPEC 1855), seasons with no in-scope events are skipped
      // (SPEC 1865, extended to the season level).
      const { rows: seasonRows } = await pool.query(
        'SELECT id, name FROM seasons WHERE internal = FALSE ORDER BY display_order ASC, starts_at DESC'
      );
      const seasons = [];
      for (const seasonRow of seasonRows) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: eventRows } = await pool.query(
          'SELECT id, name FROM season_events WHERE season_id = $1 AND internal = FALSE ORDER BY starts_at ASC',
          [seasonRow.id]
        );
        const events = [];
        for (const eventRow of eventRows) {
          // eslint-disable-next-line no-await-in-loop
          const { obj, hasSnapshot } = await buildEventBreakdown(pool, req.user.id, eventRow, {
            includeActivity, omitBonusKeys: true,
          });
          if (hasSnapshot) events.push(obj);
        }
        if (events.length) seasons.push({ id: Number(seasonRow.id), name: seasonRow.name, events });
      }
      return ok(res, { data: { display_name: displayName, scope: 'global', seasons } });
    } catch (err) {
      log.error('topochain-mobile', 'GET /me/breakdown failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };
  router.get('/api/v4/mobile/me/breakdown', mobileTokenAuth(config), meBreakdownHandler);

  // ── GET /event/points (SPEC 1867-1893) ───────────────────────────────
  // Rename #1: `event_id` -> `season_event_id`. Rename #2:
  // `participant_total_points` -> `user_total_points` (value documented
  // at the field below). SPEC 1893: v4 paginates `total_points_per_user`
  // (unpaginated + unfiltered in the source, flagged as a data-exposure
  // note) via the shared page/per_page + `meta` envelope.
  router.get('/api/v4/mobile/event/points', mobileTokenAuth(config), async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      if (!seasonEventId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The season_event_id field is required.'] },
        });
      }

      const { rows } = await pool.query('SELECT id, name, internal FROM season_events WHERE id = $1', [seasonEventId]);
      const event = rows[0];
      if (!event) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }
      if (event.internal) return fail(res, 404, 'Event not found.');

      const { page, perPage } = paginate(req); // may throw ValidationError (422)

      const { rows: latestRows } = await pool.query(
        `SELECT DISTINCT ON (user_id) user_id, total_points
           FROM leaderboard_snapshots
          WHERE season_event_id = $1
          ORDER BY user_id, snapshot_at DESC, id DESC`,
        [seasonEventId]
      );
      const sorted = latestRows
        .map((r) => ({ user_id: Number(r.user_id), total_points: num(r.total_points) ?? 0 }))
        .sort((a, b) => b.total_points - a.total_points || a.user_id - b.user_id);

      const eventTotalPoints = sorted.reduce((acc, r) => acc + r.total_points, 0);
      const start = (page - 1) * perPage;
      const totalPointsPerUser = sorted.slice(start, start + perPage);

      return ok(res, {
        data: {
          season_event_id: Number(event.id),
          event_name: event.name,
          event_total_points: eventTotalPoints,
          // Rename #2 judgment call: the source computes this identically
          // to event_total_points (both are "sum of every participant's
          // total_points for the event") — kept equal rather than
          // inventing a second, undocumented aggregate.
          user_total_points: eventTotalPoints,
          total_points_per_user: totalPointsPerUser,
          total_participants: sorted.length,
        },
      }, { meta: meta(page, perPage, sorted.length) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-mobile', 'GET /event/points failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /leaderboard (SPEC 1895-1932) ────────────────────────────────
  // Rename #1: `event_id` -> `season_event_id`.
  const leaderboardHandler = async (req, res) => {
    try {
      const seasonId = toIntId(req.query.season_id);
      if (!seasonId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_id: ['The season_id field is required.'] },
        });
      }

      const { rows } = await pool.query('SELECT id, name, internal FROM seasons WHERE id = $1', [seasonId]);
      const season = rows[0];
      if (!season) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_id: ['The selected season_id is invalid.'] },
        });
      }
      if (season.internal) return fail(res, 404, 'Season not found.');

      const seasonEventId = toIntId(req.query.season_event_id);
      let event = null;
      if (seasonEventId) {
        const { rows: evRows } = await pool.query(
          'SELECT id, name, season_id, internal FROM season_events WHERE id = $1',
          [seasonEventId]
        );
        event = evRows[0];
        // Judgment call: an id that doesn't exist, OR exists but belongs
        // to a different season, is treated the same as an unknown id
        // (422) — the request is asking for an event that isn't "this
        // season's". An existing, same-season but internal event 404s
        // like every other internal-event lookup in this migration.
        if (!event || Number(event.season_id) !== Number(season.id)) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        if (event.internal) return fail(res, 404, 'Event not found.');
      }

      const { page, perPage } = paginate(req, { defaultPerPage: 50 }); // may throw ValidationError

      // SPEC 1931-1932: only public events with a leaderboard; the
      // season-type wrap-up event is renamed "<Season name> Global
      // Challenges".
      const { rows: eventRows } = await pool.query(
        `SELECT id, name, type, starts_at, ends_at, is_active
           FROM season_events
          WHERE season_id = $1 AND internal = FALSE AND display_leaderboard = TRUE
          ORDER BY starts_at DESC`,
        [season.id]
      );
      const events = eventRows.map((r) => ({
        id: Number(r.id),
        name: r.type === 'season' ? `${season.name} Global Challenges` : r.name,
        type: r.type,
        starts_at: iso(r.starts_at),
        ends_at: iso(r.ends_at),
        is_active: r.is_active,
      }));

      const isSeasonScope = !event;
      const scopedRows = isSeasonScope
        ? await fetchSeasonScopeLeaderboard(pool, season.id)
        : await fetchEventScopeLeaderboard(pool, event.id);

      const total = scopedRows.length;
      const start = (page - 1) * perPage;
      const leaderboard = scopedRows.slice(start, start + perPage).map((r) => formatMobileLeaderboardRow(r, isSeasonScope));

      return ok(res, {
        data: {
          season: { id: Number(season.id), name: season.name },
          events,
          leaderboard,
          // SPEC's own example nests pagination under `data`, distinct
          // from the shared top-level `meta` envelope every other
          // paginated v4 endpoint uses — "specification wins" (Global
          // Constraints), so this one key is deliberately not `meta`.
          pagination: meta(page, perPage, total),
        },
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-mobile', 'GET /leaderboard failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };
  router.get('/api/v4/mobile/leaderboard', mobileTokenAuth(config), leaderboardHandler);

  // ── GET /challenges (SPEC 1934-1974) ─────────────────────────────────
  // Scope resolution: season_event_id > season_id > the current active
  // public season; no scope resolves -> empty array (SPEC's own words).
  const challengesHandler = async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      const seasonIdParam = toIntId(req.query.season_id);
      const activeOnly = parseBoolDefaultFalse(req.query.active_only);
      const onlyScheduled = parseBoolDefaultFalse(req.query.only_scheduled);

      let rows;
      let resolvedSeasonId = null;
      if (seasonEventId) {
        const { rows: evRows } = await pool.query('SELECT id FROM season_events WHERE id = $1', [seasonEventId]);
        if (!evRows.length) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
        rows = await fetchChallengesForEvent(pool, seasonEventId);
      } else {
        let seasonId = seasonIdParam;
        if (seasonId) {
          const { rows: seasonRows } = await pool.query('SELECT id, internal FROM seasons WHERE id = $1', [seasonId]);
          const season = seasonRows[0];
          if (!season) {
            return fail(res, 422, 'The given data was invalid.', {
              details: { season_id: ['The selected season_id is invalid.'] },
            });
          }
          // SPEC's error table for this endpoint lists exactly ONE 404,
          // "Season not found." — the same message /me/ranking's own
          // season scope uses for an internal season (Task 9 precedent).
          // No equivalent event-level 404 exists in that table, so the
          // season_event_id branch above never internal-checks the event.
          if (season.internal) return fail(res, 404, 'Season not found.');
        } else {
          const { rows: currentRows } = await pool.query(
            `SELECT id FROM seasons
              WHERE internal = FALSE AND is_active = TRUE
                AND starts_at <= NOW() AND ends_at >= NOW()
              ORDER BY starts_at DESC, id DESC LIMIT 1`
          );
          if (!currentRows.length) return ok(res, { data: [] });
          seasonId = Number(currentRows[0].id);
        }
        resolvedSeasonId = seasonId;
        rows = await fetchChallengesForSeason(pool, seasonId);
      }

      const onboarding = await loadOnboarding(pool, req.user.id,
        { seasonId: resolvedSeasonId, eventId: seasonEventId });
      rows = visibleChallenges(rows, onboarding);
      const ids = rows.map((r) => Number(r.id));
      const activityRows = ids.length ? await fetchOwnChallengeActivities(pool, req.user.id, ids) : [];
      const activitiesByChallenge = new Map();
      for (const a of activityRows) {
        const list = activitiesByChallenge.get(a.challenge_id) || [];
        list.push(a);
        activitiesByChallenge.set(a.challenge_id, list);
      }

      let items = rows.map((r) => {
        const list = activitiesByChallenge.get(Number(r.id)) || [];
        return buildMobileChallengeItem(r, {
          activities: list.map((a) => ({
            points: num(a.points) ?? 0, description: a.description, activity_at: iso(a.activity_at),
          })),
          // activities_total: this endpoint's own aggregate, summed from
          // the SAME rows `activities` carries (judgment call: mirrors
          // /me/breakdown's challenge_progress.earned_points precedent —
          // "sum of the user's own points on this challenge" is the one
          // number both call sites need, so there's no second query).
          activitiesTotal: list.reduce((acc, a) => acc + (num(a.points) ?? 0), 0),
        });
      });

      // The viewer's block count, per season event — this list can span a
      // whole season, so one event id is not enough. Loaded once, and only
      // when the list actually holds a block-production card (#2492).
      const blocksByEvent = items.some((it) => it.metric?.kind === 'blocks_produced')
        ? await loadEventBlocks(pool, req.user.id, items.map((it) => it.season_event_id))
        : new Map();

      for (const item of items) {
        item.category = challengeCategory(item.id, item.category, onboarding);
        if (onboarding?.progress.has(item.id)) {
          item.progress = onboarding.progress.get(item.id);
          continue;
        }
        // Progress used to ride along on the three onboarding rows only,
        // because they were the only ones anything credited without an admin
        // typing it in. The card's `_isDone` reads `progress.done`, so every
        // other challenge fell through to "is there any activity" and showed
        // "Started" — for good, even to somebody who had finished it and been
        // paid. Automatic scoring makes that the NORMAL state of four of the
        // nine Season 2 challenges, so the same rule now applies to all of
        // them, from the activity rows this handler has already loaded.
        //
        // `blocks_produced` is in this now (#2492). It was left out while its
        // count had nowhere to come from — block scores are written to
        // leaderboard snapshots and never to the ledger — so its card drew a
        // ring with no words beside it while Home, reading the snapshot,
        // showed the real number. The snapshot count is passed in here, and
        // the done rule, the clamp and the target stay the shared ones.
        const metricKind = item.metric ? item.metric.kind : null;
        item.progress = resolveProgress({
          metricKind,
          metricTarget: item.metric ? item.metric.target : null,
          activityCount: (activitiesByChallenge.get(Number(item.id)) || []).length,
          blocks: blocksByEvent.get(Number(item.season_event_id)),
        });
      }

      // active_only (SPEC: "keeps enabled and not-completed challenges").
      if (activeOnly) items = items.filter((it) => it.enabled && !it.completed);
      // only_scheduled (SPEC: "keeps challenges whose window contains
      // now, or with no window") — evaluated against the EFFECTIVE
      // (already-merged) schedule, matching the override semantics the
      // rest of this endpoint applies.
      if (onlyScheduled) {
        const now = Date.now();
        items = items.filter((it) => {
          if (!it.schedule_start && !it.schedule_end) return true;
          const startOk = !it.schedule_start || new Date(it.schedule_start).getTime() <= now;
          const endOk = !it.schedule_end || new Date(it.schedule_end).getTime() >= now;
          return startOk && endOk;
        });
      }

      return ok(res, { data: items, ...(onboarding ? { onboarding: onboarding.summary } : {}) });
    } catch (err) {
      log.error('topochain-mobile', 'GET /challenges failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };
  router.get('/api/v4/mobile/challenges', mobileTokenAuth(config), challengesHandler);

  // ── GET /seasons (SPEC 1976-2029) ────────────────────────────────────
  const seasonsHandler = async (req, res) => {
    try {
      const seasonIdParam = toIntId(req.query.season_id);
      const seasonEventIdParam = toIntId(req.query.season_event_id);

      if (seasonIdParam) {
        const { rows } = await pool.query('SELECT id FROM seasons WHERE id = $1', [seasonIdParam]);
        if (!rows.length) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_id: ['The selected season_id is invalid.'] },
          });
        }
      }
      if (seasonEventIdParam) {
        const { rows } = await pool.query('SELECT id FROM season_events WHERE id = $1', [seasonEventIdParam]);
        if (!rows.length) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
      }

      // The 12 optional filters (task brief), each defaulting per SPEC
      // 1976-2029: the three challenge-list gates default TRUE
      // (parseBoolDefaultTrue), everything else defaults FALSE.
      const onlyActiveSeasons = parseBoolDefaultFalse(req.query.only_active_seasons);
      const onlyCurrentSeason = parseBoolDefaultFalse(req.query.only_current_season);
      const includeInternalSeasons = parseBoolDefaultFalse(req.query.include_internal_seasons);
      const onlyActiveEvents = parseBoolDefaultFalse(req.query.only_active_events);
      const onlyCurrentEvents = parseBoolDefaultFalse(req.query.only_current_events);
      const includeInternalEvents = parseBoolDefaultFalse(req.query.include_internal_events);
      const includeChallenges = parseBoolDefaultTrue(req.query.include_challenges);
      const includeCompletedChallenges = parseBoolDefaultTrue(req.query.include_completed_challenges);
      const onlyEnabledChallenges = parseBoolDefaultTrue(req.query.only_enabled_challenges);
      const challengeCategory = typeof req.query.challenge_category === 'string' ? req.query.challenge_category.trim() : '';

      const seasonConds = [];
      const seasonParams = [];
      if (seasonIdParam) { seasonParams.push(seasonIdParam); seasonConds.push(`id = $${seasonParams.length}`); }
      if (!includeInternalSeasons) seasonConds.push('internal = FALSE');
      if (onlyActiveSeasons) seasonConds.push('is_active = TRUE');
      if (onlyCurrentSeason) seasonConds.push('starts_at <= NOW() AND ends_at >= NOW()');
      const seasonWhere = seasonConds.length ? `WHERE ${seasonConds.join(' AND ')}` : '';

      // Seasons newest first (SPEC's own words); events within each season
      // are fetched oldest first by fetchSeasonEventsWithChallenges below.
      const { rows: seasonRows } = await pool.query(
        `SELECT id, name, description, starts_at, ends_at, is_active
           FROM seasons ${seasonWhere}
          ORDER BY starts_at DESC, id DESC`,
        seasonParams
      );

      const data = [];
      for (const season of seasonRows) {
        const onboarding = includeChallenges
          ? await loadOnboarding(pool, req.user.id, { seasonId: season.id }) : null;
        // eslint-disable-next-line no-await-in-loop -- fixture-scale lists
        // (same precedent as /me/breakdown's global scope above).
        const events = await fetchSeasonEventsWithChallenges(pool, season.id, {
          seasonEventIdParam, onlyActiveEvents, onlyCurrentEvents, includeInternalEvents,
          includeChallenges, includeCompletedChallenges, onlyEnabledChallenges, challengeCategory,
          onboarding,
        });
        const seasonObj = {
          season_id: Number(season.id),
          name: season.name,
          description: season.description,
          starts_at: iso(season.starts_at),
          ends_at: iso(season.ends_at),
          is_active: season.is_active,
          events,
          ...(onboarding ? { onboarding: onboarding.summary } : {}),
        };
        if (includeChallenges) {
          // "season_challenges ... same shape, from the season-type
          // event" — reuses the SAME already-built challenges array off
          // whichever event in `events` has type 'season', rather than a
          // second query (Task 3's season_events.type column, SPEC's own
          // 'regular'/'season' values).
          const seasonTypeEvent = events.find((e) => e.type === 'season');
          seasonObj.season_challenges = seasonTypeEvent ? seasonTypeEvent.challenges || [] : [];
        }
        data.push(seasonObj);
      }

      return ok(res, { data });
    } catch (err) {
      log.error('topochain-mobile', 'GET /seasons failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  };
  router.get('/api/v4/mobile/seasons', mobileTokenAuth(config), seasonsHandler);

  // ── /challenges-api (SV web shell reads) ─────────────────────────────
  // The SV chrome screens (#challenges and #profile — public/js/
  // challenges.js, public/js/profile.js) render the same data the mobile
  // app pulls from the five GET surfaces above, but authenticate with the
  // platform session cookie instead of a mobile bearer token. Before the
  // topochain merge these paths were a read-only proxy in server.js to the
  // retired external leaderboard deployment; now they are the SAME
  // in-process handlers with session identity. Post-migration participant
  // ids ARE platform user ids, so /me/* scope to the session user — the
  // old proxy's client-claimed `participant_id` query param is ignored
  // (mobileTokenAuth's own "never trust a client-supplied id" rule,
  // Constraint #12, now holds on the web surface too).
  const webSessionAuth = optionalSessionAuth(config);
  const requireSessionUser = (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Unauthenticated.');
    return next();
  };
  router.get('/challenges-api/seasons', webSessionAuth, requireSessionUser, seasonsHandler);
  router.get('/challenges-api/challenges', webSessionAuth, requireSessionUser, challengesHandler);
  router.get('/challenges-api/leaderboard', webSessionAuth, requireSessionUser, leaderboardHandler);
  router.get('/challenges-api/me/ranking', webSessionAuth, requireSessionUser, meRankingHandler);
  router.get('/challenges-api/me/breakdown', webSessionAuth, requireSessionUser, meBreakdownHandler);
  // Terms review + consent (thin-shell migration): the native terms
  // screen is gone; SV settings renders the current terms and posts the
  // consent with the platform session. The handlers are hoisted function
  // declarations defined further down.
  router.get('/challenges-api/terms/current', webSessionAuth, requireSessionUser, termsCurrentHandler);
  router.post('/challenges-api/terms/consent', webSessionAuth, requireSessionUser, termsConsentHandler);
  // Block-producer queue (onboarding flow alignment): the SV settings UI
  // shows "Ask to produce blocks" and its pending/released state with
  // the platform session.
  router.get('/challenges-api/bp/state', webSessionAuth, requireSessionUser, bpStateHandler);
  router.post('/challenges-api/bp/request', webSessionAuth, requireSessionUser, bpRequestHandler);
  // Everything else under /challenges-api keeps the old proxy allowlist's
  // "off-list -> 404" contract instead of falling through to the SPA
  // catch-all (which would 200 with index.html) or authMiddleware's 401.
  router.use('/challenges-api', (_req, res) => fail(res, 404, 'Not found.'));

  // ── GET /terms/current (SPEC 2046-2065) ──────────────────────────────
  // Hoisted function declaration (not inline) so the /challenges-api web
  // registrations above — which sit BEFORE this point so they beat the
  // 404 catch-all — can reference it (thin-shell migration: terms review
  // and consent live in SV settings, session-cookie authed).
  async function termsCurrentHandler(req, res) {
    try {
      const { rows } = await pool.query(
        `SELECT id, version, title, terms_link, published_at FROM terms_versions
          WHERE published_at IS NOT NULL
          ORDER BY published_at DESC, id DESC LIMIT 1`
      );
      const current = rows[0];
      if (!current) return fail(res, 404, 'No published terms version.');

      const { rows: consentRows } = await pool.query(
        'SELECT status, responded_at FROM user_terms_consents WHERE user_id = $1 AND terms_version_id = $2',
        [req.user.id, current.id]
      );
      const consent = consentRows[0] || null;

      return ok(res, {
        data: {
          id: Number(current.id),
          version: current.version,
          title: current.title,
          terms_link: current.terms_link,
          published_at: iso(current.published_at),
          consent: {
            status: consent ? consent.status : null,
            accepted: !!(consent && consent.status === 'accepted'),
            responded_at: consent ? iso(consent.responded_at) : null,
          },
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'GET /terms/current failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  // ── POST /terms/consent (SPEC 2067-2090) ─────────────────────────────
  // One row per (user, terms_version) — `user_terms_consents`'s own
  // UNIQUE(user_id, terms_version_id) (schema.sql) backs the upsert below,
  // which is how re-posting a DIFFERENT status withdraws/changes consent
  // (SPEC's own words: "overwritten on re-post ... how a user withdraws
  // consent"). IP + app_version are recorded but never echoed back in the
  // response (SPEC 2089). Hoisted for the /challenges-api registration
  // above, like termsCurrentHandler.
  async function termsConsentHandler(req, res) {
    try {
      const body = req.body || {};
      const details = {};

      const termsVersionId = toIntId(body.terms_version_id);
      if (!termsVersionId) details.terms_version_id = ['The terms_version_id field is required.'];

      const status = body.status;
      if (status !== 'accepted' && status !== 'refused') {
        details.status = ['The status field must be one of: accepted, refused.'];
      }

      let appVersion = null;
      if (body.app_version !== undefined && body.app_version !== null) {
        const s = String(body.app_version);
        if (s.length > 255) {
          details.app_version = ['The app_version field must not exceed 255 characters.'];
        } else {
          appVersion = s;
        }
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows: versionRows } = await pool.query(
        'SELECT id, version, published_at FROM terms_versions WHERE id = $1',
        [termsVersionId]
      );
      const version = versionRows[0];
      if (!version) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { terms_version_id: ['The selected terms_version_id is invalid.'] },
        });
      }
      if (!version.published_at) {
        return fail(res, 422, 'Cannot consent to an unpublished terms version.');
      }

      const ip = clientIp(req) || null;
      const respondedAt = new Date();

      const { rows } = await pool.query(
        `INSERT INTO user_terms_consents
           (user_id, terms_version_id, status, responded_at, ip, app_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (user_id, terms_version_id) DO UPDATE
           SET status = EXCLUDED.status, responded_at = EXCLUDED.responded_at,
               ip = EXCLUDED.ip, app_version = EXCLUDED.app_version, updated_at = NOW()
         RETURNING user_id, terms_version_id, status, responded_at`,
        [req.user.id, termsVersionId, status, respondedAt, ip, appVersion]
      );
      const row = rows[0];

      return ok(res, {
        data: {
          user_id: Number(row.user_id),
          terms_version_id: Number(row.terms_version_id),
          version: version.version,
          status: row.status,
          responded_at: iso(row.responded_at),
        },
      });
    } catch (err) {
      log.error('topochain-mobile', 'POST /terms/consent failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  // ── POST /zkpassport/complete (SPEC 2092-2141; 2939, 2961-2973 for the
  // replay-index/metadata resolution) ──────────────────────────────────
  //
  // Judgment calls (documented here rather than scattered, since the
  // error ladder below is long and each check is short):
  //   1. SPEC's 404 "challenge has no event" is read as "challenge_id
  //      doesn't resolve to a real challenges row" — the schema's own
  //      NOT NULL FK (challenges.season_event_id) makes a challenge
  //      existing WITHOUT an event unreachable, so there is nothing else
  //      this condition could mean.
  //   2. `source` = 'zkpassport': SPEC 883/2939 keeps activity `source`
  //      values "verbatim (scanner/agent values)" from the source system,
  //      but the source's own zkPassport flow wrote to a NOW-EXCLUDED
  //      completions table, not `user_activities` — there is no verbatim
  //      value for this path. 'zkpassport' is a new, clearly-named value
  //      (the column is free-text VARCHAR(255), no enum/CHECK), the same
  //      way partner.js's own insert already uses a new value ('api') for
  //      an endpoint the source's own `user_activities`-equivalent table
  //      never wrote through either.
  //   3. `leaderboard_refreshed`: v4 has no leaderboard-refresh machinery
  //      at all (snapshots are written by the §8 load tooling later in
  //      this plan, never by a live per-request job) — set to `false`
  //      rather than `true` on every response, new or idempotent, since
  //      claiming a refresh happened would misstate the actual system
  //      state; this mirrors the §4.10 "challenge_progress placeholder"
  //      precedent of reporting the honest absence of a mechanism rather
  //      than a fabricated success.
  router.post('/api/v4/mobile/zkpassport/complete', mobileTokenAuth(config), async (req, res) => {
    try {
      const body = req.body || {};
      const details = {};

      const challengeId = toIntId(body.challenge_id);
      if (!challengeId) details.challenge_id = ['The challenge_id field is required.'];

      const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
      if (!sessionId || sessionId.length > 255) {
        details.session_id = ['The session_id field is required and must be at most 255 characters.'];
      }

      const nullifierHex = typeof body.nullifier_hex === 'string' ? body.nullifier_hex.trim() : '';
      if (!nullifierHex || nullifierHex.length > 255 || !/^0x[0-9a-fA-F]+$/.test(nullifierHex)) {
        details.nullifier_hex = ['The nullifier_hex field is required and must match 0x[0-9a-fA-F]+.'];
      }

      const walletAddress = typeof body.wallet_address === 'string' ? body.wallet_address.trim() : '';
      if (!walletAddress || walletAddress.length > 255) {
        details.wallet_address = ['The wallet_address field is required and must be at most 255 characters.'];
      }

      let requestedCompletedAt = null;
      if (body.completed_at !== undefined && body.completed_at !== null && body.completed_at !== '') {
        const parsed = new Date(body.completed_at);
        if (Number.isNaN(parsed.getTime())) {
          details.completed_at = ['The completed_at field must be a valid date.'];
        } else {
          requestedCompletedAt = parsed;
        }
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // ── 404: challenge has no event (judgment call #1 above) ─────────
      const { rows: challengeRows } = await pool.query(
        `SELECT c.id, c.season_event_id, c.enabled, c.completed,
                c.schedule_start, c.schedule_end, c.reward,
                ct.category AS t_category, ct.schedule_start AS t_schedule_start,
                ct.schedule_end AS t_schedule_end, ct.reward AS t_reward,
                se.season_id
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE c.id = $1`,
        [challengeId]
      );
      const challenge = challengeRows[0];
      if (!challenge) return fail(res, 404, 'Challenge not found.');

      // ── 422: challenge disabled ───────────────────────────────────────
      if (!challenge.enabled) return fail(res, 422, 'This challenge is disabled.');

      // ── 409: challenge no longer accepting completions ────────────────
      if (challenge.completed) return fail(res, 409, 'This challenge is no longer accepting completions.');

      // ── 422: window not started / already ended (effective schedule,
      // override ?? template — same merge rule GET /challenges applies) ─
      const effStart = challenge.schedule_start != null ? challenge.schedule_start : challenge.t_schedule_start;
      const effEnd = challenge.schedule_end != null ? challenge.schedule_end : challenge.t_schedule_end;
      const now = new Date();
      if (effStart != null && now < new Date(effStart)) {
        return fail(res, 422, 'This challenge has not started yet.');
      }
      if (effEnd != null && now > new Date(effEnd)) {
        return fail(res, 422, 'This challenge has already ended.');
      }

      // ── 422: user not enrolled (event-scoped OR season-wide, same
      // two-partial-unique shape partner.js's own enrollment check uses) ─
      const { rows: enrollRows } = await pool.query(
        `SELECT id FROM user_enrollments
          WHERE user_id = $1
            AND (season_event_id = $2 OR (season_event_id IS NULL AND season_id = $3))
          LIMIT 1`,
        [req.user.id, challenge.season_event_id, challenge.season_id]
      );
      if (!enrollRows.length) return fail(res, 422, 'You are not enrolled in this event.');

      // ── 422: wallet mismatch vs the user's account for this event ────
      const { rows: acctRows } = await pool.query(
        `SELECT id FROM onchain_accounts
          WHERE user_id = $1 AND address = $2
            AND (season_event_id = $3 OR (season_event_id IS NULL AND season_id = $4))
          LIMIT 1`,
        [req.user.id, walletAddress, challenge.season_event_id, challenge.season_id]
      );
      if (!acctRows.length) return fail(res, 422, 'This wallet does not match your account for this event.');

      // ── Idempotent short-circuit (SPEC note): BEFORE any bridge call ──
      const { rows: existingRows } = await pool.query(
        `SELECT id, metadata, activity_at, created_at
           FROM user_activities
          WHERE user_id = $1 AND challenge_id = $2 AND metadata->>'kind' = 'challenge_completion'
          LIMIT 1`,
        [req.user.id, challengeId]
      );
      if (existingRows.length) {
        const existing = existingRows[0];
        const md = existing.metadata || {};
        return ok(res, {
          data: {
            completion_id: Number(existing.id),
            user_id: Number(req.user.id),
            season_event_id: Number(challenge.season_event_id),
            challenge_id: challengeId,
            activity_id: Number(existing.id),
            session_id: md.session_id || null,
            nullifier_hex: md.nullifier_hex || null,
            completed_at: iso(existing.activity_at),
            verified_at: iso(existing.created_at),
            leaderboard_refreshed: false,
            already_recorded: true,
          },
        });
      }

      // ── 409: this zkPassport session already used — a DIFFERENT
      // (user, challenge) pair, since the idempotency check above already
      // excluded a match on THIS pair ─────────────────────────────────
      const { rows: sessionRows } = await pool.query(
        `SELECT id FROM user_activities
          WHERE metadata->>'kind' = 'challenge_completion' AND metadata->>'session_id' = $1
          LIMIT 1`,
        [sessionId]
      );
      if (sessionRows.length) return fail(res, 409, 'This zkPassport session has already been used.');

      // ── 409: this proof already claimed for this challenge ────────────
      const { rows: nullifierRows } = await pool.query(
        `SELECT id FROM user_activities WHERE challenge_id = $1 AND metadata->>'nullifier_hex' = $2 LIMIT 1`,
        [challengeId, nullifierHex]
      );
      if (nullifierRows.length) return fail(res, 409, 'This proof has already been claimed for this challenge.');

      // ── 500: challenge reward missing / non-numeric / not positive ────
      const effReward = challenge.reward != null ? challenge.reward : challenge.t_reward;
      const points = Number(effReward);
      if (!Number.isFinite(points) || points <= 0) {
        return fail(res, 500, "This challenge's reward is not a valid positive number.");
      }

      // ── Call the bridge — 500 "not configured" (zk-bridge.js's own
      // ZkBridgeError), 502 request-or-payload failure, 422 not-verified ─
      let bridgeResult;
      try {
        bridgeResult = await verifyCompletion(config, {
          challengeId, sessionId, nullifierHex, walletAddress,
        });
      } catch (err) {
        if (err instanceof ZkBridgeError) return fail(res, err.status, err.message);
        throw err;
      }
      if (!bridgeResult.verified) {
        return fail(res, 422, 'The zkPassport bridge did not report a successful verification.');
      }

      const verifiedAt = new Date();
      const completedAt = requestedCompletedAt || bridgeResult.completedAt || verifiedAt;
      const activityType = challenge.t_category || 'zkpassport_completion';
      const metadata = {
        kind: 'challenge_completion', session_id: sessionId, nullifier_hex: nullifierHex, wallet_address: walletAddress,
      };

      // ── One transaction: the activity row IS the completion row (no
      // separate completions table — SPEC §4.10). A unique-violation on
      // either replay index (a race the pre-checks above didn't catch)
      // maps to the same two 409s those pre-checks already report.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Verification can outlive the middleware lookup. Revalidate and hold
        // the exact protocol-2 credential at the final write boundary so
        // logout either waits for this completion or makes it fail closed.
        const { rows: credentialRows } = await client.query(
          `SELECT c.credential_reference
             FROM native_session_credentials c
             JOIN mobile_auth_tokens t
               ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
            WHERE c.mobile_auth_token_id = $1 AND c.user_id = $2
              AND c.state = 'valid' AND c.expires_at > NOW()
              AND t.ability = 'session' AND t.expires_at > NOW()
            FOR SHARE OF c`,
          [req.mobileAuth.tokenId, req.user.id]
        );
        if (!credentialRows.length) {
          await client.query('ROLLBACK');
          return fail(res, 401, 'Unauthenticated.');
        }
        const { rows: insertRows } = await client.query(
          `INSERT INTO user_activities
             (user_id, season_event_id, activity_type, points, description, metadata,
              activity_at, source, challenge_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'zkpassport', $8, $9, $9)
           RETURNING id`,
          [req.user.id, challenge.season_event_id, activityType, points, null,
            JSON.stringify(metadata), completedAt, challengeId, verifiedAt]
        );
        await client.query('COMMIT');

        return res.status(201).json({
          success: true,
          data: {
            completion_id: Number(insertRows[0].id),
            user_id: Number(req.user.id),
            season_event_id: Number(challenge.season_event_id),
            challenge_id: challengeId,
            activity_id: Number(insertRows[0].id),
            session_id: sessionId,
            nullifier_hex: nullifierHex,
            completed_at: iso(completedAt),
            verified_at: iso(verifiedAt),
            leaderboard_refreshed: false,
            already_recorded: false,
          },
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
          if (err.constraint === 'user_activities_nullifier_unique') {
            return fail(res, 409, 'This proof has already been claimed for this challenge.');
          }
          // Any other unique-violation on this insert is the completion
          // index (user_id, challenge_id) — the only other one this table
          // carries.
          return fail(res, 409, 'This challenge has already been completed.');
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      log.error('topochain-mobile', 'POST /zkpassport/complete failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /wallet/claim ────────────────────────────────────────────────
  // A platform account can predate the mobile/social identity merge. In
  // that case its current-season wallet remains attached to the legacy
  // email-backed user while the native handoff authenticates a newer
  // social user. When the seeded wallet pool is exhausted, provisioning
  // cannot repair that split by allocating another pre-funded key.
  //
  // The claim happens before native exchange: the authenticated Social web
  // session identifies the target, the legacy email OTP proves the source,
  // and the normal protocol-2 exchange subsequently delivers the claimed key
  // in its encrypted envelope. There is no second secret-bearing wallet API.
  router.post(
    '/api/v4/mobile/wallet/claim',
    // After optionalSessionAuth, not before: the limiter keys per user and
    // the route already requires a live web session, so req.user has to be
    // populated before its key is computed.
    optionalSessionAuth(config),
    mobileWalletClaimLimiter,
    async (req, res) => {
      const sessionToken = req.cookies?.session;
      if (!req.user || !sessionToken) return fail(res, 401, 'Unauthenticated.');

      const email = walletClaimEmail(req.body?.email);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      const details = {};
      if (!email) details.email = ['The email must be a valid email address.'];
      if (!/^\d{6}$/.test(code)) details.code = ['The code must be 6 digits.'];
      if (Object.keys(details).length) {
        return fail(res, 422, 'The given data was invalid.', { details, code: 'wallet_claim_invalid' });
      }

      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Hold the exact web credential through the transfer. Logout takes an
        // UPDATE lock on this row, so it either waits for a completed claim or
        // removes admission before this operation can start.
        const { rows: sessionRows } = await client.query(
          `SELECT user_id FROM sessions
            WHERE token = $1 AND user_id = $2 AND expires_at > NOW()
              AND ${nativeWebSessionIsLive('sessions')}
            FOR SHARE`,
          [sessionToken, req.user.id]
        );
        if (!sessionRows.length) {
          await client.query('ROLLBACK');
          return fail(res, 401, 'Unauthenticated.');
        }

        const { rows: otpRows } = await client.query(
          `SELECT id, code_hash, attempts, expires_at
             FROM mobile_otp_codes
            WHERE email = $1 AND consumed_at IS NULL
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            FOR UPDATE`,
          [email]
        );
        const otp = otpRows[0];
        const otpInvalid = !otp
          || new Date(otp.expires_at) < new Date()
          || Number(otp.attempts) >= WALLET_CLAIM_MAX_OTP_ATTEMPTS;
        if (otpInvalid) {
          await client.query('ROLLBACK');
          return fail(res, 422, 'Invalid or expired code.', { code: 'wallet_claim_invalid' });
        }

        if (!(await bcrypt.compare(code, otp.code_hash))) {
          await client.query(
            'UPDATE mobile_otp_codes SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1',
            [otp.id]
          );
          await client.query('COMMIT');
          return fail(res, 422, 'Invalid or expired code.', { code: 'wallet_claim_invalid' });
        }

        // Resolve the legacy identity, then lock both users in id order.
        // Re-check the source email after locking so a concurrent profile
        // update cannot make a code authorize a now-different address.
        const { rows: sourceLookupRows } = await client.query(
          'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1',
          [email]
        );
        const sourceId = sourceLookupRows[0] ? Number(sourceLookupRows[0].id) : null;
        if (!sourceId || sourceId === Number(req.user.id)) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'No different programme wallet is linked to that email.', {
            code: 'wallet_claim_not_found',
          });
        }

        const { rows: lockedUsers } = await client.query(
          `SELECT id, email FROM users
            WHERE id = ANY($1::bigint[])
            ORDER BY id
            FOR UPDATE`,
          [[Number(req.user.id), sourceId]]
        );
        const lockedSource = lockedUsers.find((user) => Number(user.id) === sourceId);
        const lockedTarget = lockedUsers.find((user) => Number(user.id) === Number(req.user.id));
        if (!lockedSource || !lockedTarget || String(lockedSource.email || '').trim().toLowerCase() !== email) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'No programme wallet is linked to that email.', {
            code: 'wallet_claim_not_found',
          });
        }

        const { rows: seasonRows } = await client.query(
          `SELECT id FROM seasons
            WHERE internal = FALSE AND is_active = TRUE
              AND starts_at <= NOW() AND ends_at >= NOW()
            ORDER BY starts_at DESC, id DESC LIMIT 1`
        );
        if (!seasonRows.length) {
          await client.query('ROLLBACK');
          return fail(res, 422, 'No active season is available.', { code: 'wallet_claim_no_season' });
        }
        const seasonId = Number(seasonRows[0].id);

        const { rows: targetAccounts } = await client.query(
          `SELECT id FROM onchain_accounts
            WHERE user_id = $1 AND season_id = $2
            LIMIT 1
            FOR UPDATE`,
          [req.user.id, seasonId]
        );
        if (targetAccounts.length) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'This account already has a wallet for the current season.', {
            code: 'wallet_claim_conflict',
          });
        }

        const { rows: sourceAccounts } = await client.query(
          `SELECT id, address, public_key, season_event_id
             FROM onchain_accounts
            WHERE user_id = $1 AND season_id = $2
            ORDER BY (season_event_id IS NULL) DESC, id ASC
            FOR UPDATE`,
          [sourceId, seasonId]
        );
        if (!sourceAccounts.length) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'No current-season programme wallet is linked to that email.', {
            code: 'wallet_claim_not_found',
          });
        }

        // TODO(wallet-claim-key-rotation): a protocol-2 credential means an
        // installation has already received this private key. Token deletion
        // cannot revoke that cryptographic authority, so refuse that rare case
        // until the chain exposes an actual key-rotation/authority-transfer
        // primitive. Pre-cutover legacy wallets have no such binding and can
        // be claimed normally.
        const { rows: credentialRows } = await client.query(
          `SELECT credential_reference FROM native_session_credentials
            WHERE account_id = ANY($1::bigint[])
            LIMIT 1
            FOR UPDATE`,
          [sourceAccounts.map((account) => String(account.id))]
        );
        if (credentialRows.length) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'This wallet requires key rotation before it can be connected.', {
            code: 'wallet_claim_requires_key_rotation',
          });
        }

        await client.query(
          `UPDATE onchain_accounts
              SET user_id = $1, updated_at = NOW()
            WHERE user_id = $2 AND season_id = $3`,
          [req.user.id, sourceId, seasonId]
        );

        const { rows: enrollmentRows } = await client.query(
          `SELECT id FROM user_enrollments
            WHERE user_id = $1 AND season_id = $2
            LIMIT 1`,
          [req.user.id, seasonId]
        );
        if (!enrollmentRows.length) {
          await client.query(
            `INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
             VALUES (NULL, $1, $2, NOW(), NOW(), NOW())`,
            [req.user.id, seasonId]
          );
        }

        await client.query(
          'UPDATE mobile_otp_codes SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1',
          [otp.id]
        );
        await client.query('DELETE FROM mobile_auth_tokens WHERE user_id = $1', [sourceId]);
        await client.query('COMMIT');

        const account = sourceAccounts[0];
        return ok(res, {
          claimed: true,
          address: account.address,
          public_key: account.public_key,
          season_id: seasonId,
          season_event_id: account.season_event_id != null ? Number(account.season_event_id) : null,
        });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
          return fail(res, 409, 'The wallet could not be connected because this account already has one.', {
            code: 'wallet_claim_conflict',
          });
        }
        log.error('topochain-mobile', 'POST /wallet/claim failed', { message: err.message });
        return fail(res, 500, 'Internal server error.');
      } finally {
        if (client) client.release();
      }
    }
  );

  return router;
}

module.exports = { topochainMobileRoutes };
