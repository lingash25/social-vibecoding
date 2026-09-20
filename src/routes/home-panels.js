// Data for the three fixed home-screen sections: Challenges, Discover and
// Create app. All are present for every signed-in account (#1801).
// GET /api/home-panels returns { registry, hidden: [], panels }.
// `hidden: []` and `removable: false` keep cached clients compatible during
// rollout. Legacy users.home_panels_hidden values are no longer read or written.

'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// THE ROW CAP IS THE CLIENT'S. The block draws four challenges
// (HomePanels.ROW_SLOTS in frontend/src/features/home/home-panels.js), and
// WHICH four is the Challenges tab's order: the group first (a finished Get
// started last), then unfinished, then featured, then display order. A
// challenge's group is only settled after the query (challengeCategory,
// below), so SQL cannot pick those four. The row query returns the collapsed
// scope up to the same ceiling as the expanded list (CHALLENGE_EXPANDED_LIMIT)
// and the client orders, groups and slices it. The four-row
// CHALLENGE_ROW_LIMIT that used to cap the query went with that.

// ─── Reward parsing ──────────────────────────────────────────────────
//
// `challenges.reward` / `challenge_templates.reward` is FREE TEXT written
// by organisers. Real production values include "Up to 6,500 pts",
// "300 pts", "1500", "½ of your final credits", "Unlocks future rewards".
// It is rendered verbatim (the client only appends " pts" to a bare
// number); this parser exists solely for the optional "N pts still on the
// table" half of the summary line, which is suppressed entirely unless
// EVERY open row's reward is a plain number. Returns null when the string
// isn't confidently numeric — never a guess.
//
// The automatic challenge scorer needs the same answer to a much less
// forgiving question ("how many points is this challenge worth"), so the
// parser moved to services/topochain/challenge-rules.js and is re-exported
// here. One parser, because two that drift would mean a challenge whose card
// promises a number the scorer refuses to pay.
const { parseRewardPoints } = require('../services/topochain/challenge-rules');

// ─── Progress resolution ─────────────────────────────────────────────
//
// THE AUTHORITATIVE PER-USER PROGRESS VALUE DOES NOT EXIST YET. The v4
// migration's `challenge_progress` deliberately returns `state: 'none'`,
// `current: null` placeholders (src/routes/topochain/mobile.js
// fetchChallengeProgress, SPEC §4.10), and `leaderboard_snapshots
// .challenge_details` cannot be joined — its `challenge_id` values are
// SOURCE-system ids (production snapshots reference 56/42/30/49 for goals
// whose platform challenges.id are 47/40/…).
//
// So this function derives progress from the points ledger:
//   * no numeric target            → binary: done once any activity row
//                                    credits the viewer for it.
//   * metric_type 'blocks_produced'→ current = the viewer's newest
//                                    snapshot's event_total_produced_blocks.
//   * any other metric with target → current = the number of the viewer's
//                                    activity rows on the challenge (one
//                                    ledger row per unit — exactly how
//                                    production challenge 58 "Test the
//                                    hackathon dApps" (target 8) is
//                                    credited, at 200 pts per app tested).
//
// The count-the-rows rule UNDER-counts where an admin credits a batch in a
// single row. It is the most honest signal available today; when a real
// per-user progress feed lands, THIS is the one function to replace.
const {
  resolveProgress, loadOnboarding, challengeCategory, NEWEST_EVENT_BLOCKS_SQL,
} = require('../services/topochain/challenge-onboarding');

// resolveProgress's done rule, in SQL. It has to exist in both languages:
// SQL needs it to sort not-done rows first and to pick WHICH rows survive
// the LIMIT, and to COUNT the done ones across every open challenge
// (including the ones past the cap). The row query selects it as
// `my_done`, and buildChallengeRow prefers that value over recomputing —
// so a real request has exactly one answer even if these two ever drift.
//
// The trap this closes: "has any ledger row" is NOT done-ness. A numeric
// challenge at 3 of 8 has three rows and is emphatically not finished; an
// earlier version sorted it to the bottom with the completed ones and
// counted it as done.
const DONE_SQL = `
    CASE
      WHEN COALESCE(c.metric_type, ct.metric_type) IS NULL
        OR COALESCE(c.metric_target, ct.metric_target) IS NULL
        OR COALESCE(c.metric_target, ct.metric_target) <= 0
        THEN %COUNT% > 0
      WHEN COALESCE(c.metric_type, ct.metric_type) = 'blocks_produced'
        THEN COALESCE(%BLOCKS%, 0) >= COALESCE(c.metric_target, ct.metric_target)
             OR (COALESCE(c.metric_target, ct.metric_target) <= 1 AND %COUNT% > 0)
      ELSE %COUNT% >= COALESCE(c.metric_target, ct.metric_target)
    END`;

// The two per-user aggregates DONE_SQL needs, as correlated subqueries
// (Postgres can't reference a SELECT-list alias from the same SELECT list,
// so they're substituted in rather than named).
const MY_COUNT_SQL = `(SELECT COUNT(*) FROM user_activities ua
              WHERE ua.user_id = $1 AND ua.challenge_id = c.id)`;
// The snapshot read now lives beside resolveProgress, because the challenge
// LISTS need the same number and a second copy of it is how the tab and Home
// came to disagree (#2492). This name is kept: profile.js imports it from
// here, and so does the test that pins the two to one rule.
const MY_BLOCKS_SQL = NEWEST_EVENT_BLOCKS_SQL;

const DONE_EXPR = DONE_SQL
  .replace(/%COUNT%/g, MY_COUNT_SQL)
  .replace(/%BLOCKS%/g, MY_BLOCKS_SQL);

// One JOINed row → the panel's per-challenge shape. `r` carries the
// challenge columns unprefixed and the template columns `t_`-prefixed
// (TEMPLATE_JOIN_COLUMNS_SQL), plus the three per-user aggregates.
//
// The challenge row overrides the template for every field it shares —
// the WIDER merge rule mobile.js established for this same data (its
// MOBILE_OVERRIDE_KEYS includes metric_*/cta_*, unlike public.js's
// deliberately narrower list). `label` is the template's category
// uppercased, 'OTHER' when unset, same as mobile.js effectiveCategory.
function buildChallengeRow(r) {
  const eff = (key) => (r[key] != null ? r[key] : r[`t_${key}`]);
  const metricKind = eff('metric_type');
  const metricTarget = eff('metric_target');
  const progress = resolveProgress({
    metricKind,
    metricTarget,
    activityCount: r.my_activity_count,
    blocks: r.my_blocks,
  });
  // The query decided done-ness (DONE_EXPR) for its own ordering and for
  // the panel's done COUNT; take that value so the chips and the "N of M
  // done" line can never disagree.
  if (r.my_done != null) progress.done = !!r.my_done;
  const ctaLink = eff('cta_link');
  return {
    id: Number(r.id),
    // The event the challenge belongs to. With `id` it is the Challenges tab's
    // deep link (#leaderboard/challenges/<event>/<challenge>) a Home card opens.
    season_event_id: r.season_event_id == null ? null : Number(r.season_event_id),
    // The Challenges tab's in-group order keys after done-ness, which the
    // client sorts on (HomePanels.orderRows): the organiser's featured flag,
    // then the display order its public list is sorted by (then `id`).
    // Additive.
    featured: r.featured === true,
    display_order: r.display_order == null ? null : Number(r.display_order),
    // The organiser's "this challenge is over" flag, which is the tab's
    // not-done key for every card outside Get started (its public list carries
    // per-user progress only for setup cards). HomePanels.orderDone sorts on it;
    // the card's check mark stays `progress.done`, the viewer's own. Additive.
    completed: r.completed === true,
    label: String(r.t_category || 'OTHER').toUpperCase(),
    icon: r.kind_icon || null,
    // The template's artwork slug (t_illustration), passed through as stored.
    // Not part of the `eff` merge: a challenge row has no illustration of its
    // own. Whether the slug actually draws is the client registry's call; the
    // card falls back to `icon` when it does not.
    illustration: r.t_illustration || null,
    // The tone of an UPLOADED illustration (TEMPLATE_JOIN_COLUMNS_SQL's
    // t_illustration_tone), null otherwise. The client only honours it for an
    // uploaded slug and only when it is one of its twelve tones.
    illustration_tone: r.t_illustration_tone || null,
    goal: eff('goal'),
    task: eff('task'),
    reward: eff('reward'),
    cta: ctaLink ? { label: eff('cta_label') || 'Get Started', link: ctaLink } : null,
    metric: progress.target == null ? null : {
      kind: metricKind,
      label: eff('metric_label'),
      target: progress.target,
    },
    progress,
    earned_points: Number(r.my_points) || 0,
    // When this challenge closes, for the card's "3d left": its own
    // schedule_end (override over template, the same COALESCE the open-row
    // filter uses), else the end of the event it belongs to — the date the
    // Challenges tab falls back to for that event. Null only when neither is
    // set; the client then uses `season.ends_at`.
    ends_at: eff('schedule_end') || r.event_ends_at || null,
    // Whether it is open now (OPEN_ONLY_WHERE, selected as `is_open`). The
    // collapsed panel holds only open rows; the expanded list also carries
    // organiser-closed and out-of-window ones, which show no countdown.
    open: r.is_open !== false,
  };
}

// The scope + filter predicate, shared verbatim by the row query and the
// COUNT that produces `total` — so the footer's "See all N" can never
// disagree with the rows above it.
//
// "Open" means: in the season that is running right now, on a PUBLIC
// (non-internal) event, organiser-enabled, not organiser-marked-finished,
// and inside its effective schedule window (or carrying no window at
// all). `completed` is an organiser flag about the CHALLENGE ("this one
// is over"), never a per-user signal — see the schema comment and
// frontend/src/features/leaderboard/topochain-challenges.js (which was
// public/js/topochain-challenges.js until #1083 chunk F).
//
// The EXPANDED view's predicate is the same season and public-event scope,
// still organiser-enabled, but WITHOUT the not-completed and in-window
// filters — expanding is how a viewer sees the season's finished
// challenges (and their own ✓ marks on them) without leaving home. The
// collapsed panel stays strictly "open". So the two live as a base and the
// extra predicate that narrows it, rather than as two hand-kept copies:
// `all_total` counts the base set and `total` counts the narrowed one, from
// one query, and the client needs both to know whether expanding would
// reveal anything at all (#1824).
const ALL_CHALLENGE_WHERE = `
        se.internal = FALSE
    AND c.enabled = TRUE`;

// What "open" adds on top: the organiser hasn't marked it over, and now is
// inside its effective schedule window (or it carries no window at all).
const OPEN_ONLY_WHERE = `
        c.completed = FALSE
    AND COALESCE(c.schedule_start, ct.schedule_start, NOW() - INTERVAL '1 second') <= NOW()
    AND COALESCE(c.schedule_end, ct.schedule_end, NOW() + INTERVAL '1 second') >= NOW()`;

const OPEN_CHALLENGE_WHERE = `${ALL_CHALLENGE_WHERE}
    AND ${OPEN_ONLY_WHERE}`;

// Hard ceiling on the rows the query returns, collapsed and expanded alike. A
// season can accumulate dozens of challenges (production's Season 1 has 58
// rows across its events), and the expanded block is still a home-screen
// widget, not the Challenges screen — the section heading's "Open challenges"
// goes there for the full list. Collapsed, it is how many rows the client
// chooses its four from.
const CHALLENGE_EXPANDED_LIMIT = 40;

// THE STANDINGS PREVIEW IS GONE, and so are the two board queries that fed
// it. `attachLeaderboardFill` used to hang a `leaderboard` block on the
// challenges panel — the head of the Topochain standings plus the viewer's own
// row, falling back to the kudos board on a deployment with no public
// standings — behind a 30s cache because both boards are identical for every
// viewer and only "which row is me" is per-request.
//
// The client stopped drawing it: two labelled lists with two different tap
// destinations inside one card called Challenges made the reader work out
// which one they were looking at before they could read either, and the
// standings are a screen the section's own heading links to. Computing a
// payload nobody renders is the kind of thing that outlives the memory of why
// it was there, so `buildTopochainFill`, `buildLeaderboardFill`,
// `rankedUsersCached`, `standingsBoardCached`, `_resetFillCache`,
// `FILL_TOP_ROWS`, `FILL_TTL_MS` and both service imports went with it. A home
// load now asks for the challenges and nothing else.

// The current active PUBLIC season — the same predicate GET /challenges
// resolves its default scope with (mobile.js). Null when nothing is
// running, which is production's state between seasons and is what makes
// the card render its compact "nothing running" state.
async function fetchCurrentSeason(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, ends_at FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
        AND starts_at <= NOW() AND ends_at >= NOW()
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return rows[0] || null;
}

// The staging demo season always ends SEVEN DAYS from now, so the card's
// "7d left" is the same string on every capture rather than counting
// down towards a fixed date and eventually reading "ended".
function demoSeasonEndsAt() {
  return new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
}

async function buildChallengesPanel(pool, user, opts) {
  // `expanded` is the in-place "See all" state: same scope, but finished
  // and out-of-window challenges come too, and the client's four-row cap
  // lifts. The
  // client grows the block past its height cap for this and the same
  // control collapses it back — nothing is persisted.
  const expanded = !!(opts && opts.expanded);
  let scopeWhere = expanded ? ALL_CHALLENGE_WHERE : OPEN_CHALLENGE_WHERE;
  // Both scopes come back whole, up to one ceiling: the client picks the
  // collapsed block's four rows (see THE ROW CAP IS THE CLIENT'S, above).
  const rowLimit = CHALLENGE_EXPANDED_LIMIT;

  const season = await fetchCurrentSeason(pool);
  if (!season) {
    // Between seasons. The panel still renders — one "nothing running" line —
    // so the area explains itself instead of vanishing.
    return {
      season: null, total: 0, all_total: 0, done: 0, points_remaining: null,
      challenges: [], expanded,
    };
  }

  const onboarding = await loadOnboarding(pool, user.id, { seasonId: season.id });
  const locked = onboarding && !onboarding.summary.unlocked;
  // The totals query counts the EXPANDED scope and narrows to the collapsed
  // one with a FILTER, so both counts come from one statement. The locked
  // onboarding restriction is part of the row query's scope; the totals
  // statement applies it per aggregate instead (below), which is what lets
  // the same statement count the challenges the gate hides.
  const gate = 'c.id = ANY($4::bigint[])';
  if (locked) scopeWhere += ` AND ${gate}`;
  // Keep the ring, sorting and remaining rewards in sync with lifetime
  // onboarding progress, including credits earned in a previous season.
  const doneExpr = onboarding
    ? `CASE WHEN c.id = ANY($4::bigint[]) THEN c.id = ANY($5::bigint[]) ELSE (${DONE_EXPR}) END`
    : DONE_EXPR;
  const onboardingParams = onboarding
    ? [onboarding.ids, onboarding.ids.filter((id) => onboarding.progress.get(id).done)] : [];
  const totalSql = (sql) => sql.replace(/\$([45])/g, (_, n) => `$${Number(n) - 1}`);

  // Rows: one statement, per-user aggregates as correlated subqueries so
  // there is no second round trip and no N+1. The ORDER BY does not decide
  // what the block draws, or in what order: HomePanels.orderRows sorts the
  // rows the Challenges tab's way. It decides which rows survive the LIMIT
  // when a season holds more than CHALLENGE_EXPANDED_LIMIT of them, so it
  // keeps the actionable ones: not-done first, then organiser-featured, then
  // the organiser's display order.
  const { rows } = await pool.query(
    `SELECT c.id, c.season_event_id, c.goal, c.task, c.reward,
            c.schedule_start, c.schedule_end,
            c.cta_label, c.cta_link,
            c.metric_type, c.metric_target, c.metric_label,
            c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
            ${TEMPLATE_JOIN_COLUMNS_SQL},
            ${MY_COUNT_SQL} AS my_activity_count,
            (SELECT COALESCE(SUM(ua.points), 0) FROM user_activities ua
              WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_points,
            ${MY_BLOCKS_SQL} AS my_blocks,
            ${doneExpr} AS my_done,
            se.ends_at AS event_ends_at,
            (${OPEN_ONLY_WHERE}) AS is_open,
            ck.icon AS kind_icon
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
       -- The card's picture, from the KIND the challenge resolves to (its own
       -- override, else its template's). One join, no extra round trip, and
       -- the icon is null for a challenge whose kind is unset or has none —
       -- which the card falls back from rather than drawing a blank.
       LEFT JOIN challenge_kinds ck ON ck.id = COALESCE(c.kind, ct.kind)
      WHERE se.season_id = $2 AND ${scopeWhere}
      ORDER BY (${doneExpr}) ASC,
               (c.featured IS NOT TRUE) ASC,
               COALESCE(c.featured_order, 2147483647) ASC,
               c.display_order ASC, c.id ASC
      LIMIT $3`,
    [user.id, season.id, rowLimit, ...onboardingParams]
  );

  // Totals over the WHOLE open set, not the page above: `total` drives the
  // client's "See all N" slot, and `open_rewards` is what makes
  // points_remaining honest. Summing only the returned rows would understate
  // "pts left" the moment a season passes the row ceiling, so collect every
  // open not-done row's effective reward here (a
  // handful of short strings) and parse them below.
  //
  // `all_total` is the size of the EXPANDED set — the same season and
  // public-event scope with the open-only predicate dropped. It is what the
  // footer's expand toggle needs to know whether it has anything to reveal:
  // a block already showing every challenge there is draws no toggle at all
  // (#1824), rather than a "See all 3 challenges" beside three challenges.
  // `scopeFilter` narrows every OTHER aggregate back to the rows above, so
  // `total`, `done` and `open_rewards` keep the exact meaning they had.
  //
  // While the onboarding gate is closed the outer WHERE stays the
  // UNRESTRICTED season scope and the gate joins every FILTER, so the counts
  // above are unchanged and `hidden_count` can count what the gate hides:
  // the OPEN challenges (the collapsed scope `total` is counted in, even when
  // expanded) whose id is not an onboarding step. It is the Home card's
  // "N challenges locked" placeholder, and it is not bounded by the row
  // LIMIT. Unlocked, this statement is exactly what it was.
  const openScope = `(${OPEN_ONLY_WHERE})`;
  const gateFilter = locked ? totalSql(gate) : null;
  const scopeFilter = [expanded ? null : openScope, gateFilter].filter(Boolean).join(' AND ') || 'TRUE';
  const allTotalSql = gateFilter ? `COUNT(*) FILTER (WHERE ${gateFilter})::int` : 'COUNT(*)::int';
  const hiddenCountSql = gateFilter
    ? `,\n            COUNT(*) FILTER (WHERE ${openScope} AND NOT (${gateFilter}))::int AS hidden_count`
    : '';
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${scopeFilter})::int AS total,
            ${allTotalSql} AS all_total,
            COUNT(*) FILTER (
              WHERE ${scopeFilter} AND (${totalSql(doneExpr)})
            )::int AS done,
            COALESCE(
              array_agg(COALESCE(c.reward, ct.reward)) FILTER (
                WHERE ${scopeFilter} AND NOT (${totalSql(doneExpr)})
              ),
              '{}'
            ) AS open_rewards${hiddenCountSql}
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE}`,
    [user.id, season.id, ...onboardingParams]
  );

  // A challenge whose template row vanished is skipped rather than 500ing
  // the panel — the same guard public.js applies to its own challenge
  // list (the FK should make it unreachable in practice).
  const challenges = rows.filter((r) => r.t_id != null).map(buildChallengeRow);
  for (const c of challenges) {
    c.label = challengeCategory(c.id, c.label, onboarding);
    if (onboarding?.progress.has(c.id)) c.progress = onboarding.progress.get(c.id);
  }

  // "Points still on the table": only when EVERY open row's reward parses
  // as a plain number. One "½ of your final credits" and the whole figure
  // is withheld rather than silently under-reported.
  const openRewards = Array.isArray(totalRows[0]?.open_rewards)
    ? totalRows[0].open_rewards : [];
  let pointsRemaining = 0;
  for (const reward of openRewards) {
    const n = parseRewardPoints(reward);
    if (n == null) { pointsRemaining = null; break; }
    pointsRemaining += n;
  }

  return {
    // `ends_at` is the season's end: the deadline a card shows when its
    // challenge carries no `ends_at` of its own (no schedule_end and no event
    // end), and what the ring says when no card on screen shows a deadline.
    season: { id: Number(season.id), name: season.name, ends_at: season.ends_at },
    total: totalRows[0]?.total ?? challenges.length,
    // How many rows an expansion would show. `total` is the OPEN count, so
    // on its own it cannot tell a full-but-short list ("nothing to expand")
    // from a short list with finished challenges behind it (#1824).
    all_total: totalRows[0]?.all_total ?? totalRows[0]?.total ?? challenges.length,
    done: totalRows[0]?.done ?? 0,
    points_remaining: pointsRemaining,
    // `hidden_count` is additive and rides only while the gate is closed.
    ...(onboarding ? {
      onboarding: locked
        ? { ...onboarding.summary, hidden_count: Number(totalRows[0]?.hidden_count) || 0 }
        : onboarding.summary,
    } : {}),
    challenges,
    expanded,
  };
}

// Staging-only demo payload (see "Staging mock data" in the platform
// conventions). The boot seed gives the three capture/admin identities
// real rows, but ANY staging reviewer signed in as their cloned prod
// identity would see zero progress; this makes every state visible
// deterministically regardless of who is looking. Read-only, obviously
// fake, written nowhere, and a strict no-op outside staging.
//
// `variant` (from ?demo=1&challenges=few|none) picks the SHORT-LIST states,
// which a staging clone cannot otherwise reach while the seeded season is
// live — they are the whole point of this change and so have to be
// URL-reachable for the checks and the screenshots:
//   'few'  → two open rows, which is the shrink a full list never shows.
//   'none' → nothing open: the compact one-line block.
// Absent/unknown → the default payload: five open rows, of which the client
// draws four.
function demoChallengesPanel(opts) {
  const expanded = !!(opts && opts.expanded);
  const variant = opts && opts.variant;
  const username = opts && opts.username;
  if (variant === 'none') {
    return {
      season: null, total: 0, all_total: 0, done: 0, points_remaining: null,
      challenges: [], expanded,
      demo: true,
    };
  }
  // The labels are the board's categories, WEEKLY and PERSISTENT, so the four
  // rows the collapsed block draws (and the `few` pair) sit under two of the
  // client's group headers, This week and Always open. Both DONE rows are
  // PERSISTENT, so Always open holds them together and they stay side by side
  // under one header (see below). The open overflow row and the finished rows
  // are in other categories: the client ranks Season challenges after Always
  // open, so the collapsed cap cuts exactly that group off, and an expansion
  // shows it as the third group.
  const rows = [
    {
      id: 900512,
      label: 'WEEKLY',
      goal: 'Staging demo challenge — test the demo dApps',
      icon: '🧪',
      illustration: 'try-three-apps',
      task: 'Open eight of the demo dApps and leave a note on each.',
      reward: 'Up to 2,100 pts',
      cta: { label: 'Get Started', link: 'https://example.invalid/staging-demo' },
      metric: { kind: 'count', label: 'Apps tested', target: 8 },
      // Roughly half — the clearest read of a part-filled outlined bar.
      progress: { done: false, current: 4, target: 8 },
      earned_points: 800,
    },
    {
      id: 900510,
      label: 'PERSISTENT',
      goal: 'Staging demo challenge — report a reproducible bug',
      icon: '🐞',
      illustration: 'useful-feedback',
      task: 'Find and file a reproducible bug report against the testnet client.',
      reward: '250 points',
      cta: null,
      metric: null,
      progress: { done: false, current: null, target: null },
      earned_points: 0,
    },
    // The two DONE rows come last in Always open (the client's orderRows puts
    // them after its unfinished row anyway) and deliberately sit next to each
    // other, in one group: one
    // binary, one numeric at full target. Seeing both kinds of "done" side
    // by side — a ✓ with no bar, and a ✓ over a bar filled end to end — is the whole
    // reason the numeric one exists here, and the collapsed block only has
    // four slots to spend.
    {
      id: 900511,
      label: 'PERSISTENT',
      goal: 'Staging demo challenge — share the season announcement',
      icon: '📣',
      // No artwork on purpose: one of the four collapsed rows keeps the
      // kind emoji, so the fallback is on screen beside the pictures.
      illustration: null,
      task: 'Share the season announcement post on social media.',
      reward: '50 points',
      cta: null,
      metric: null,
      progress: { done: true, current: null, target: null },
      earned_points: 50,
    },
    {
      id: 900516,
      label: 'PERSISTENT',
      goal: 'Staging demo challenge — vote on five proposals',
      icon: '🗳️',
      illustration: 'make-a-proposal',
      task: 'Cast a vote on five open proposals from other builders.',
      reward: '900 pts',
      cta: null,
      metric: { kind: 'count', label: 'Proposals voted', target: 5 },
      progress: { done: true, current: 5, target: 5 },
      earned_points: 900,
    },
  ];
  // Open, and sent with the collapsed rows as the real builder sends every
  // open row, but past the four slots the client draws — the empty 0-of-5
  // track, the least informative of the numeric states and so the one that
  // gives up its slot to the finished numeric above. Its category is outside
  // the board's three, so it ranks in Season challenges, the group after
  // Always open, which is what puts it past the cap. Expanding shows it.
  const overflow = [
    {
      id: 900513,
      label: 'COMMUNITY',
      goal: 'Staging demo challenge — give kudos to five builders',
      icon: '👏',
      illustration: 'proposal-accepted',
      task: 'Send kudos on five merged proposals from other builders.',
      reward: '1500',
      cta: null,
      metric: { kind: 'count', label: 'Kudos', target: 5 },
      progress: { done: false, current: 0, target: 5 },
      earned_points: 0,
    },
  ];
  // Expanding shows the season's FINISHED challenges too — the state the
  // collapsed panel filters out. Two organiser-closed rows, one of which
  // the viewer completed, so the ✓-on-a-finished-challenge case is
  // reviewable from the demo route as well as the seeded one.
  const finished = [
    {
      id: 900514,
      label: 'FLASH',
      goal: 'Staging demo challenge — closed: live feedback session',
      icon: '🎧',
      illustration: 'useful-feedback',
      task: 'Joined the live feedback call and left notes.',
      reward: '500 points',
      cta: null,
      metric: null,
      progress: { done: true, current: null, target: null },
      earned_points: 500,
      completed: true,
      open: false,
    },
    {
      id: 900515,
      label: 'TECHNICAL',
      goal: 'Staging demo challenge — closed: stress load round',
      icon: '🏋️',
      illustration: 'network-participation',
      task: 'The stress-load round has finished.',
      reward: 'Up to 500 pts',
      cta: null,
      metric: null,
      progress: { done: false, current: null, target: null },
      earned_points: 0,
      // Organiser-closed, as the real builder's `is_open` would say: the card
      // shows no countdown for it.
      completed: true,
      open: false,
    },
  ];

  // The SHORT-LIST variant: two open rows, one metered and one binary, so
  // the progress-bar lane is still exercised at the smaller size. `total`
  // AND `all_total` both match the rows shown — nothing is past the cap and
  // nothing is behind an expansion either, so this is the state where the
  // footer draws NO expand toggle (#1824). It carries no finished rows for
  // exactly that reason: a "See all 2 challenges" beside two challenges is
  // the bug, and this route is what the check and the screenshots navigate
  // to in order to prove it is gone.
  if (variant === 'few') {
    const few = [rows[0], rows[1]];
    return {
      season: { id: 900500, name: 'Staging Demo Season — Topochain', ends_at: demoSeasonEndsAt() },
      total: 2,
      all_total: 2,
      done: 0,
      points_remaining: null,
      challenges: few,
      expanded,
      demo: true,
    };
  }

  // Collapsed returns every open row, the four the client draws and the
  // overflow, as the real builder does now that the client picks the four.
  // `total` deliberately exceeds them so the footer reads "See all 7
  // challenges" and the expand toggle has something to reveal. Expanded
  // returns the open rows PLUS the finished ones, which is exactly what the
  // real builder does when it drops the not-completed filter.
  const all = expanded ? [...rows, ...overflow, ...finished] : [...rows, ...overflow];
  return {
    season: { id: 900500, name: 'Staging Demo Season — Topochain', ends_at: demoSeasonEndsAt() },
    total: expanded ? all.length : 7,
    // Seven either way: the four drawn rows, the one open row past the cap,
    // and the two finished ones an expansion reveals. More than is shown, so
    // this route keeps the toggle the `few` route no longer draws.
    all_total: 7,
    done: expanded ? 3 : 2,
    points_remaining: null,
    challenges: all,
    expanded,
    demo: true,
  };
}

// The registry is unconditional; app creation permission controls the Create
// app section's action, never its presence. Discover and Create app need no
// additional queries: their data is already supplied by the home screen.
const PANEL_REGISTRY = [
  {
    key: 'challenges',
    title: 'Challenges',
    build: buildChallengesPanel,
    demo: demoChallengesPanel,
  },
  {
    key: 'discover',
    title: 'Discover',
    build: async () => ({}),
    demo: () => ({ demo: true }),
  },
  {
    key: 'create',
    title: 'Create app',
    build: async () => ({}),
    demo: () => ({ demo: true }),
  },
];

const PANEL_KEYS = new Set(PANEL_REGISTRY.map((p) => p.key));

function panelRegistryPublic() {
  return PANEL_REGISTRY.map((p) => ({
    key: p.key,
    title: p.title,
    // Compatibility for cached clients that still expose widget controls.
    removable: false,
  }));
}

function homePanelRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/home-panels', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const registry = panelRegistryPublic();
    try {
      const demo = IS_STAGING && req.query.demo === '1';
      // ?expand=<key> asks one panel for its expanded list (finished
      // challenges included, row cap lifted). Per-visit UI state, so it
      // rides on the request rather than being stored.
      const expandKey = typeof req.query.expand === 'string' ? req.query.expand : '';
      // ?demo=1&challenges=few|none picks a demo variant of the challenges
      // payload — the short-list states a seeded staging season can't reach.
      // Staging-only (it rides on `demo`, which is already IS_STAGING-gated)
      // and read-only; an unknown value falls through to the default payload.
      const variant = typeof req.query.challenges === 'string' ? req.query.challenges : '';
      const panels = [];
      for (const panel of PANEL_REGISTRY) {
        const expanded = expandKey === panel.key;
        try {
          const data = demo && panel.demo
            ? panel.demo({ expanded, variant, username: req.user.username })
            : await panel.build(pool, req.user, { expanded });
          panels.push({ key: panel.key, title: panel.title, ...data });
        } catch (err) {
          // One broken panel must never blank the home screen — log it
          // and serve the rest.
          log.error('home-panels', 'panel build failed', {
            key: panel.key, userId: req.user.id, message: err.message,
          });
        }
      }
      return res.json({ registry, hidden: [], panels });
    } catch (err) {
      log.error('home-panels', 'GET /api/home-panels failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  homePanelRoutes,
  // Exported for tests / future blocks, and for src/routes/home-layout.js,
  // which reads PANEL_KEYS to drop stored widget rows from a pre-overhaul
  // arrangement. It used to import `widgetSize` too, and validated a written
  // layout's overlaps against the SAME footprints the client laid out with;
  // nothing is placed any more, so there is no footprint to agree on.
  PANEL_REGISTRY,
  PANEL_KEYS,
  panelRegistryPublic,
  parseRewardPoints,
  resolveProgress,
  buildChallengeRow,
  // The per-user done-ness rule, in both languages, plus the scope
  // predicate — exported so the #profile screen's completed-challenges
  // endpoint (src/routes/profile.js, issue #982) asks the SAME question
  // this widget asks instead of becoming a third, drifting copy. See
  // resolveProgress's own comment: when a real per-user progress feed
  // lands, that function is still the single place to replace.
  DONE_EXPR,
  MY_COUNT_SQL,
  MY_BLOCKS_SQL,
  OPEN_CHALLENGE_WHERE,
  ALL_CHALLENGE_WHERE,
  demoChallengesPanel,
};
