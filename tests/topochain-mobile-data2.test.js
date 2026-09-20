// Topochain v4 mobile data endpoints — part 2 (plan Task 10; SPEC §4.5
// lines 1934-2191 for the six endpoint contracts, 883-895 for the §4.8
// contract deltas, 2939 + 2961-2973 for the zkpassport metadata/replay-
// index resolution).
//
// Same idiom as tests/topochain-mobile-data.test.js: HTTP-level tests
// against a throwaway express app + a substring-dispatching mock pool (no
// live DB). Auth goes through the REAL mobileTokenAuth middleware against
// a seeded `mobile_auth_tokens` fixture. Unlike Task 9's test file, this
// one needs (a) mutable user_activities fixture state, so it follows
// tests/topochain-partner-api.test.js's reset-before-each pattern instead;
// and (b) a `global.fetch` stub for the zk-bridge calls,
// since src/services/topochain/zk-bridge.js talks to the bridge via the
// bare global `fetch` (never injected through the pool).
//
// Run with: node --test tests/topochain-mobile-data2.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Fixture data (mostly immutable — mutable pieces noted below) ───────

const USERS = [
  { id: 1, email: 'alice@example.com' },
  { id: 3, email: 'carol@example.com' }, // has an existing zkpassport completion
  { id: 4, email: 'dave@example.com' }, // enrolled, wrong wallet
  { id: 5, email: 'erin@example.com' }, // not enrolled anywhere
  { id: 8, email: 'heidi@example.com' }, // fresh zkpassport happy-path user
  { id: 9, email: 'ivan@example.com' }, // holds session/nullifier-collision rows
];

const TOKENS = [
  { user_id: 1, raw: 'alice-token' },
  { user_id: 3, raw: 'carol-token' },
  { user_id: 4, raw: 'dave-token' },
  { user_id: 5, raw: 'erin-token' },
  { user_id: 8, raw: 'heidi-token' },
].map((t) => ({ ...t, token_hash: crypto.createHash('sha256').update(t.raw).digest('hex'), ability: 'session', expires_at: T(1) }));

// Season 10: current (is_active + NOW within window) -> the "current
// active public season" GET /challenges falls back to with no scope.
// Season 20: internal (hidden everywhere).
// Season 30: public but NOT current (ended in the past) — exercises
// only_current_season and the seasons "newest first" ordering (10 is
// newer than 30, since 10.starts_at > 30.starts_at).
const SEASONS = [
  { id: 10, name: 'Season Alpha', description: 'alpha desc', internal: false, is_active: true, starts_at: T(-30), ends_at: T(30) },
  { id: 20, name: 'Hidden Season', description: null, internal: true, is_active: true, starts_at: T(-30), ends_at: T(30) },
  { id: 30, name: 'Season Beta', description: 'beta desc', internal: false, is_active: true, starts_at: T(-100), ends_at: T(-50) },
];

// Event 100: season 10's regular event — every GET /challenges +
// zkpassport fixture challenge lives here. Event 103: season 10's
// season-type event (season_challenges). Event 102: internal (excluded by
// default from /seasons). Event 300: season 30's only event.
const SEASON_EVENTS = [
  { id: 100, season_id: 10, type: 'regular', name: 'Sprint One', description: 'sprint', internal: false, is_active: true, starts_at: T(-10), ends_at: T(20) },
  { id: 102, season_id: 10, type: 'regular', name: 'Internal Event', description: null, internal: true, is_active: true, starts_at: T(-5), ends_at: T(5) },
  { id: 103, season_id: 10, type: 'season', name: 'Wrap-up raw name', description: null, internal: false, is_active: true, starts_at: T(20), ends_at: T(30) },
  { id: 300, season_id: 30, type: 'regular', name: 'Beta Event', description: null, internal: false, is_active: true, starts_at: T(-90), ends_at: T(-60) },
];

const CHALLENGE_TEMPLATES = [
  {
    id: 10, category: 'onchain_tx', kind: 'SEND_TX', goal: 'Send a tx', task: 'Send it', reward: '10',
    description: 'template desc', requirements: 'template req', reward_logic: 'template logic',
    schedule_start: null, schedule_end: null, cta_type: 'button', cta_label: null, cta_link: 'https://t/cta',
    mobile_cta_type: 'button', mobile_cta_label: 'Go Mobile', mobile_cta_link: 'app://go',
    metric_type: 'blocks_produced', metric_target: '10.0000', metric_label: 'Blocks',
  },
  {
    id: 11, category: null, kind: 'OTHER', goal: 'Other goal', task: 'Other task', reward: '5',
    description: null, requirements: null, reward_logic: null,
    schedule_start: null, schedule_end: null, cta_type: null, cta_label: 'Existing Label', cta_link: null,
    mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null,
    metric_type: null, metric_target: null, metric_label: null,
  },
];

// All CHALLENGES below live in event 100 unless noted. `reward`/`kind`/
// `cta_label`/schedule fields left `null` inherit the template's value
// (the "override ?? template" merge under test).
const CHALLENGES = [
  { id: 1, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 1, featured: true, featured_order: 1 },
  { id: 2, season_event_id: 100, challenge_template_id: 11, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: false, completed: false, display_order: 2, featured: false, featured_order: null }, // disabled
  { id: 3, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: true, display_order: 3, featured: false, featured_order: null }, // completed (no longer accepting)
  { id: 4, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: T(-100), schedule_end: T(-90), cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 4, featured: false, featured_order: null }, // window ended
  { id: 5, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: T(50), schedule_end: T(60), cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 5, featured: false, featured_order: null }, // window not started
  { id: 6, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: 'not-a-number', description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 6, featured: false, featured_order: null }, // bad reward
  { id: 7, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 7, featured: false, featured_order: null }, // session-reuse target
  { id: 8, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 8, featured: false, featured_order: null }, // nullifier-reuse target
  { id: 9, season_event_id: 100, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 9, featured: false, featured_order: null }, // unique-violation race trigger
  { id: 70, season_event_id: 103, challenge_template_id: 10, goal: null, task: null, reward: null, description: null, requirements: null, reward_logic: null, schedule_start: null, schedule_end: null, cta_type: null, cta_label: null, cta_link: null, mobile_cta_type: null, mobile_cta_label: null, mobile_cta_link: null, kind: null, metric_type: null, metric_target: null, metric_label: null, enabled: true, completed: false, display_order: 1, featured: false, featured_order: null }, // season_challenges fixture
];

const USER_ENROLLMENTS = [
  { user_id: 3, season_event_id: 100, season_id: 10 },
  { user_id: 4, season_event_id: 100, season_id: 10 },
  { user_id: 8, season_event_id: 100, season_id: 10 },
  // erin (5) deliberately has NO enrollment row anywhere.
];

const ONCHAIN_ACCOUNTS = [
  { user_id: 3, address: 'wallet_carol_100', season_event_id: 100, season_id: 10 },
  { user_id: 4, address: 'wallet_dave_100', season_event_id: 100, season_id: 10 },
  { user_id: 8, address: 'wallet_heidi_100', season_event_id: 100, season_id: 10 },
];

// ─── Mutable state — reset before every test ────────────────────────────

let userActivities;
let nextActivityId;
let nativeCredentialActiveAtWrite;
// The viewer's newest leaderboard snapshot per season event, keyed by event
// id (#2492). Block scores are only ever written there, never to the points
// ledger, so this is where a `blocks_produced` challenge's count comes from.
let eventBlocks;

function resetFixtures() {
  userActivities = [
    // carol's existing completion of challenge 1 — the idempotency fixture.
    {
      id: 1, user_id: 3, challenge_id: 1, points: '10.00',
      metadata: { kind: 'challenge_completion', session_id: 'sess-carol-1', nullifier_hex: '0xdeadc001', wallet_address: 'wallet_carol_100' },
      activity_at: T(-2), created_at: T(-2),
    },
    // ivan holds the session/nullifier that collision tests probe against
    // — a DIFFERENT (user, challenge) pair than whatever the test targets.
    {
      id: 2, user_id: 9, challenge_id: 1, points: '10.00',
      metadata: { kind: 'challenge_completion', session_id: 'sess-taken', nullifier_hex: '0xdead1001', wallet_address: 'wallet_ivan' },
      activity_at: T(-3), created_at: T(-3),
    },
    {
      id: 3, user_id: 9, challenge_id: 8, points: '10.00',
      metadata: { kind: 'challenge_completion', session_id: 'sess-ivan-8', nullifier_hex: '0xdeadbeef', wallet_address: 'wallet_ivan' },
      activity_at: T(-3), created_at: T(-3),
    },
  ];
  nextActivityId = 100;
  nativeCredentialActiveAtWrite = true;
  // carol has produced 4 of the 10 blocks challenge 1 asks for.
  eventBlocks = new Map([[100, 4]]);
}

// ─── Mock pool ───────────────────────────────────────────────────────────

function buildChallengeRow(c) {
  const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
  const ev = SEASON_EVENTS.find((e) => e.id === c.season_event_id);
  return {
    id: c.id, season_event_id: c.season_event_id, event_name: ev.name, event_type: ev.type,
    goal: c.goal, task: c.task, reward: c.reward, description: c.description, requirements: c.requirements,
    schedule_start: c.schedule_start, schedule_end: c.schedule_end, reward_logic: c.reward_logic,
    cta_type: c.cta_type, cta_label: c.cta_label, cta_link: c.cta_link,
    mobile_cta_type: c.mobile_cta_type, mobile_cta_label: c.mobile_cta_label, mobile_cta_link: c.mobile_cta_link,
    kind: c.kind, metric_type: c.metric_type, metric_target: c.metric_target, metric_label: c.metric_label,
    enabled: c.enabled, completed: c.completed, display_order: c.display_order, featured: c.featured, featured_order: c.featured_order,
    t_id: t.id, t_category: t.category,
    t_goal: t.goal, t_task: t.task, t_reward: t.reward, t_description: t.description, t_requirements: t.requirements,
    t_schedule_start: t.schedule_start, t_schedule_end: t.schedule_end, t_reward_logic: t.reward_logic,
    t_cta_type: t.cta_type, t_cta_label: t.cta_label, t_cta_link: t.cta_link,
    t_mobile_cta_type: t.mobile_cta_type, t_mobile_cta_label: t.mobile_cta_label, t_mobile_cta_link: t.mobile_cta_link,
    t_kind: t.kind, t_metric_type: t.metric_type, t_metric_target: t.metric_target, t_metric_label: t.metric_label,
  };
}

// Shared handler for ALL THREE "challenges JOIN season_events JOIN
// challenge_templates" queries (mobile.js's fetchChallengesForEvent /
// fetchChallengesForSeason / fetchSeasonEventChallengeItems) — they share
// one SELECT/JOIN shape and differ only in WHERE, so the mock parses
// which conditions are textually present rather than keying off three
// separate exact-string patterns.
function challengeJoinRows(sql, params) {
  let candidates;
  if (sql.includes('WHERE se.season_id = $1 AND se.internal = FALSE')) {
    const seasonId = params[0];
    candidates = CHALLENGES.filter((c) => {
      const ev = SEASON_EVENTS.find((e) => e.id === c.season_event_id);
      return ev && ev.season_id === seasonId && !ev.internal;
    });
  } else {
    const eventId = params[0];
    candidates = CHALLENGES.filter((c) => c.season_event_id === eventId);
    if (sql.includes('AND c.enabled = TRUE')) candidates = candidates.filter((c) => c.enabled);
    if (sql.includes('AND c.completed = FALSE')) candidates = candidates.filter((c) => !c.completed);
    if (sql.includes('UPPER(ct.category) = UPPER(')) {
      const cat = params[params.length - 1];
      candidates = candidates.filter((c) => {
        const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
        return t.category && t.category.toUpperCase() === String(cat).toUpperCase();
      });
    }
  }
  return candidates.slice().sort((a, b) => a.display_order - b.display_order || a.id - b.id).map(buildChallengeRow);
}

function seasonEventsRows(sql, params) {
  const seasonId = params[0];
  let candidates = SEASON_EVENTS.filter((e) => e.season_id === seasonId);
  let paramIdx = 1;
  if (sql.includes('AND id = $')) { candidates = candidates.filter((e) => e.id === params[paramIdx]); paramIdx += 1; }
  if (sql.includes('internal = FALSE')) candidates = candidates.filter((e) => !e.internal);
  if (sql.includes('is_active = TRUE')) candidates = candidates.filter((e) => e.is_active);
  if (sql.includes('starts_at <= NOW() AND ends_at >= NOW()')) {
    const now = Date.now();
    candidates = candidates.filter((e) => e.starts_at.getTime() <= now && e.ends_at.getTime() >= now);
  }
  return candidates.slice().sort((a, b) => a.starts_at - b.starts_at || a.id - b.id);
}

function seasonsRows(sql, params) {
  let candidates = SEASONS.slice();
  let paramIdx = 0;
  if (sql.includes('id = $1')) { candidates = candidates.filter((s) => s.id === params[paramIdx]); paramIdx += 1; }
  if (sql.includes('internal = FALSE')) candidates = candidates.filter((s) => !s.internal);
  if (sql.includes('is_active = TRUE')) candidates = candidates.filter((s) => s.is_active);
  if (sql.includes('starts_at <= NOW() AND ends_at >= NOW()')) {
    const now = Date.now();
    candidates = candidates.filter((s) => s.starts_at.getTime() <= now && s.ends_at.getTime() >= now);
  }
  return candidates.slice().sort((a, b) => b.starts_at - a.starts_at || b.id - a.id);
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);
  if (sql.startsWith('/* challenge onboarding */')) return { rows: [] };

  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

  // mobileTokenAuth.
  if (sql.startsWith('SELECT t.id, c.user_id, t.ability, t.expires_at,')) {
    const tok = TOKENS.find((t) => t.token_hash === params[0]);
    if (!tok) return { rows: [] };
    const user = USERS.find((u) => u.id === tok.user_id);
    return { rows: [{
      id: tok.user_id,
      user_id: tok.user_id,
      ability: tok.ability,
      expires_at: tok.expires_at,
      credential_reference: `nsc_${'A'.repeat(43)}`,
      credential_generation: 1,
      installation_id: `nsi_${'B'.repeat(43)}`,
      credential_expires_at: tok.expires_at,
      renewal_due: false,
      username: user.email,
    }] };
  }

  // ── GET /challenges: event/season existence + current-season fallback ──
  if (sql.startsWith('SELECT id FROM season_events WHERE id = $1')) {
    const ev = SEASON_EVENTS.find((e) => e.id === params[0]);
    return { rows: ev ? [{ id: ev.id }] : [] };
  }
  if (sql.startsWith('SELECT id, internal FROM seasons WHERE id = $1')) {
    const s = SEASONS.find((x) => x.id === params[0]);
    return { rows: s ? [{ id: s.id, internal: s.internal }] : [] };
  }
  if (sql.startsWith('SELECT id FROM seasons WHERE internal = FALSE AND is_active = TRUE')) {
    if (global.__noCurrentSeason) return { rows: [] };
    const now = Date.now();
    const rows = SEASONS.filter((s) => !s.internal && s.is_active && s.starts_at.getTime() <= now && s.ends_at.getTime() >= now)
      .sort((a, b) => b.starts_at - a.starts_at || b.id - a.id);
    return { rows: rows.length ? [{ id: rows[0].id }] : [] };
  }

  // ── GET /seasons: season_id / season_event_id existence checks ──────────
  if (sql === 'SELECT id FROM seasons WHERE id = $1') {
    const s = SEASONS.find((x) => x.id === params[0]);
    return { rows: s ? [{ id: s.id }] : [] };
  }

  // ── Shared challenge+template join (all three GET /challenges + GET
  // /seasons call sites) — checked AFTER the zkpassport challenge lookup
  // below (a fourth, differently-shaped query that also happens to touch
  // both tables) so the more specific pattern gets first refusal.
  if (sql.includes('FROM challenges c') && sql.includes('challenge_templates ct')
    && !sql.startsWith('SELECT c.id, c.season_event_id, c.enabled, c.completed')) {
    return { rows: challengeJoinRows(sql, params) };
  }

  // ── GET /challenges: the user's own activities on the in-scope ids ──────
  if (sql.startsWith('SELECT challenge_id, points, description, activity_at FROM user_activities')) {
    const [userId, ids] = params;
    const rows = userActivities
      .filter((a) => a.user_id === userId && ids.includes(a.challenge_id))
      .map((a) => ({ challenge_id: a.challenge_id, points: a.points, description: a.description || null, activity_at: a.activity_at }));
    return { rows };
  }

  // ── GET /seasons: season list, then per-season event list ──────────────
  if (sql.startsWith('SELECT id, name, description, starts_at, ends_at, is_active FROM seasons')) {
    return { rows: seasonsRows(sql, params) };
  }
  if (sql.startsWith('SELECT id, type, name, description, starts_at, ends_at, is_active FROM season_events')) {
    return { rows: seasonEventsRows(sql, params) };
  }

  // ── POST /zkpassport/complete ─────────────────────────────────────────
  if (sql.startsWith('SELECT c.id, c.season_event_id, c.enabled, c.completed')) {
    const c = CHALLENGES.find((x) => x.id === params[0]);
    if (!c) return { rows: [] };
    const t = CHALLENGE_TEMPLATES.find((tt) => tt.id === c.challenge_template_id);
    const ev = SEASON_EVENTS.find((e) => e.id === c.season_event_id);
    return {
      rows: [{
        id: c.id, season_event_id: c.season_event_id, enabled: c.enabled, completed: c.completed,
        schedule_start: c.schedule_start, schedule_end: c.schedule_end, reward: c.reward,
        t_category: t.category, t_schedule_start: t.schedule_start, t_schedule_end: t.schedule_end, t_reward: t.reward,
        season_id: ev.season_id,
      }],
    };
  }
  if (sql.startsWith('SELECT id FROM user_enrollments WHERE user_id = $1')) {
    const [userId, eventId, seasonId] = params;
    const row = USER_ENROLLMENTS.find((e) => e.user_id === userId
      && (e.season_event_id === eventId || (e.season_event_id == null && e.season_id === seasonId)));
    return { rows: row ? [{ id: 1 }] : [] };
  }
  if (sql.startsWith('SELECT id FROM onchain_accounts WHERE user_id = $1 AND address = $2')) {
    const [userId, address, eventId, seasonId] = params;
    const row = ONCHAIN_ACCOUNTS.find((a) => a.user_id === userId && a.address === address
      && (a.season_event_id === eventId || (a.season_event_id == null && a.season_id === seasonId)));
    return { rows: row ? [{ id: 1 }] : [] };
  }
  if (sql.startsWith('SELECT id, metadata, activity_at, created_at')) {
    const [userId, challengeId] = params;
    const row = userActivities.find((a) => a.user_id === userId && a.challenge_id === challengeId
      && a.metadata && a.metadata.kind === 'challenge_completion');
    return { rows: row ? [{ id: row.id, metadata: row.metadata, activity_at: row.activity_at, created_at: row.created_at }] : [] };
  }
  if (sql.startsWith("SELECT id FROM user_activities WHERE metadata->>'kind' = 'challenge_completion' AND metadata->>'session_id' = $1")) {
    const [sessionId] = params;
    const row = userActivities.find((a) => a.metadata && a.metadata.kind === 'challenge_completion' && a.metadata.session_id === sessionId);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith("SELECT id FROM user_activities WHERE challenge_id = $1 AND metadata->>'nullifier_hex' = $2")) {
    const [challengeId, nullifierHex] = params;
    const row = userActivities.find((a) => a.challenge_id === challengeId && a.metadata && a.metadata.nullifier_hex === nullifierHex);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('SELECT c.credential_reference FROM native_session_credentials')) {
    return { rows: nativeCredentialActiveAtWrite ? [{ credential_reference: 'nsc_test' }] : [] };
  }
  if (sql.startsWith('INSERT INTO user_activities')) {
    const [userId, seasonEventId, activityType, points, description, metadataJson, activityAt, challengeId, verifiedAt] = params;
    const metadata = JSON.parse(metadataJson);
    // Race-simulation sentinels (documented in the tests that use them):
    // force a unique-violation error out of the insert itself, exactly as
    // a real concurrent request would trigger against the two partial
    // unique indexes, regardless of what the pre-checks already found.
    if (metadata.nullifier_hex === '0xdead0001') {
      const err = new Error('duplicate key value violates unique constraint "user_activities_nullifier_unique"');
      err.code = '23505'; err.constraint = 'user_activities_nullifier_unique';
      throw err;
    }
    if (metadata.nullifier_hex === '0xdead0002') {
      const err = new Error('duplicate key value violates unique constraint "user_activities_completion_unique"');
      err.code = '23505'; err.constraint = 'user_activities_completion_unique';
      throw err;
    }
    const row = {
      id: nextActivityId++, user_id: userId, season_event_id: seasonEventId, activity_type: activityType,
      points: Number(points).toFixed(2), description, metadata, activity_at: activityAt, challenge_id: challengeId, created_at: verifiedAt,
    };
    userActivities.push(row);
    return { rows: [{ id: row.id }] };
  }

  if (sql.startsWith('/* challenge event blocks */')) {
    const [, eventIds] = params;
    return { rows: (eventIds || []).map((eventId) => ({
      season_event_id: eventId,
      blocks: eventBlocks.has(eventId) ? eventBlocks.get(eventId) : null,
    })) };
  }

  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return {
    query: async (sql, params) => handleQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => handleQuery(sql, params),
      release: () => {},
    }),
  };
}

// ─── Test app wiring ──────────────────────────────────────────────────

function withApp(configOverrides, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  const mockPool = makeMockPool();
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test', ...configOverrides }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(configOverrides, fn) {
  return withApp(configOverrides, async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

function bearer(raw) {
  return { authorization: `Bearer ${raw}` };
}
const ALICE = bearer('alice-token');
const CAROL = bearer('carol-token');
const DAVE = bearer('dave-token');
const ERIN = bearer('erin-token');
const HEIDI = bearer('heidi-token');

const BRIDGE_URL = 'http://fake-zk-bridge.test';

function getJson(base, path, headers) {
  return fetch(`${base}${path}`, { headers });
}
function postJson(base, path, body, headers) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

// Temporarily replaces the global `fetch` the zk-bridge service calls,
// restoring the original afterward even if `fn` throws. `fn` itself ALSO
// makes real fetch() calls (postJson/getJson, to the local test server) —
// the SAME bare global `fetch` zk-bridge.js uses — so this only routes
// requests whose URL starts with the fake bridge's own base through the
// mock `handler`; every other URL (the local server) falls through to the
// real original fetch, unmocked.
async function withFetchMock(handler, fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.startsWith(BRIDGE_URL)) return handler(url, opts);
    return original(url, opts);
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

function bridgeResponse(body, ok = true) {
  return { ok, json: async () => body };
}

test.beforeEach(() => resetFixtures());

// ─── GET /challenges (SPEC 1934-1974) ───────────────────────────────────

test('GET /challenges: event scope — effective merge, category uppercase, cta_label fallback, metric object, own activities', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_event_id=100', CAROL);
    assert.equal(res.status, 200);
    const body = await res.json();
    const item = body.data.find((c) => c.id === 1);
    assert.equal(item.category, 'ONCHAIN_TX', 'template category uppercased');
    assert.equal(item.kind, 'SEND_TX', 'kind falls back to the template (challenge.kind is null)');
    assert.equal(item.reward, '10', 'reward falls back to the template');
    assert.equal(item.cta_label, 'Get Started', 'no effective cta_label -> the v4-standardized fallback');
    assert.deepEqual(item.metric, { kind: 'blocks_produced', label: 'Blocks', target: 10 });
    // #2492: a block-production challenge carries progress like any other,
    // counted from the viewer's newest snapshot rather than from the ledger
    // (carol's one ledger row here is an organiser completion worth 10 pts,
    // not four blocks). Without it the card drew a ring and no words.
    assert.deepEqual(item.progress, { done: false, current: 4, target: 10 });
    assert.equal(item.event_name, 'Sprint One');
    assert.equal(item.event_type, 'regular');
    // carol has one existing completion of challenge 1 (the idempotency fixture).
    assert.equal(item.activities.length, 1);
    assert.equal(item.activities[0].points, 10);
    assert.equal(item.activities_total, 10);
  });
});

test('GET /challenges: category falls back to OTHER when the template has none', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_event_id=100', CAROL);
    const body = await res.json();
    const item = body.data.find((c) => c.id === 2);
    assert.equal(item.category, 'OTHER');
    assert.equal(item.metric, null, 'no metric configured on this template');
    assert.equal(item.cta_label, 'Existing Label', 'an existing cta_label is never overwritten by the fallback');
  });
});

test('GET /challenges: active_only keeps only enabled + not-completed', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_event_id=100&active_only=true', CAROL);
    const body = await res.json();
    const ids = body.data.map((c) => c.id);
    assert.ok(!ids.includes(2), 'disabled challenge excluded');
    assert.ok(!ids.includes(3), 'completed challenge excluded');
    assert.ok(ids.includes(1), 'enabled + not-completed challenge kept');
  });
});

test('GET /challenges: only_scheduled keeps in-window + no-window, drops ended/not-started', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_event_id=100&only_scheduled=true', CAROL);
    const body = await res.json();
    const ids = body.data.map((c) => c.id);
    assert.ok(ids.includes(1), 'no window at all -> kept');
    assert.ok(!ids.includes(4), 'window already ended -> dropped');
    assert.ok(!ids.includes(5), 'window not started yet -> dropped');
  });
});

test('GET /challenges: no scope and no current active public season -> empty array', async () => {
  global.__noCurrentSeason = true;
  try {
    await withServer({}, async (base) => {
      const res = await getJson(base, '/api/v4/mobile/challenges', CAROL);
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).data, []);
    });
  } finally {
    global.__noCurrentSeason = false;
  }
});

test('GET /challenges: no scope falls back to the current active public season', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges', CAROL);
    const body = await res.json();
    assert.ok(body.data.some((c) => c.season_event_id === 100), 'season 10 (current) -> event 100 -> its challenges');
  });
});

test('GET /challenges: unknown season_event_id -> 422', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_event_id=999999', CAROL);
    assert.equal(res.status, 422);
  });
});

test('GET /challenges: internal season -> 404 "Season not found."', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/challenges?season_id=20', CAROL);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: 'Season not found.' });
  });
});

// ─── GET /seasons (SPEC 1976-2029) ───────────────────────────────────────

test('GET /seasons: default filters — nested seasons/events/challenges, category uppercase, kind rename, cta_label fallback, season_challenges from the season-type event', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons', ALICE);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Newest-first: season 10 (starts T(-30)) before season 30 (starts T(-100)).
    // Hidden Season (20) is internal -> never appears (default include_internal_seasons=false).
    assert.deepEqual(body.data.map((s) => s.season_id), [10, 30]);

    const season10 = body.data.find((s) => s.season_id === 10);
    // Events oldest first: 100 (starts T(-10)) before 103 (starts T(20)).
    // Internal event 102 never appears (default include_internal_events=false).
    assert.deepEqual(season10.events.map((e) => e.season_event_id), [100, 103]);

    const event100 = season10.events.find((e) => e.season_event_id === 100);
    // only_enabled_challenges defaults TRUE -> disabled challenge 2 excluded.
    // include_completed_challenges defaults TRUE -> completed challenge 3 IS included.
    const chIds = event100.challenges.map((c) => c.challenge_id);
    assert.ok(!chIds.includes(2), 'disabled challenge excluded by default');
    assert.ok(chIds.includes(3), 'completed challenge included by default');

    const ch1 = event100.challenges.find((c) => c.challenge_id === 1);
    assert.equal(ch1.category, 'ONCHAIN_TX', 'v4 standardizes on uppercase here too (a documented deviation from SPEC v3)');
    assert.equal(ch1.kind, 'SEND_TX', 'sub_category -> kind rename, effective merge');
    assert.equal(ch1.cta_label, 'Get Started', 'the fallback applies on /seasons too (the "one behavior" v4 picks)');
    assert.ok(!('metric' in ch1), 'the compact /seasons challenge shape has no metric key');
    assert.ok(!('activities' in ch1), 'nor an activities key');

    const seasonTypeEvent = season10.events.find((e) => e.type === 'season');
    assert.deepEqual(season10.season_challenges, seasonTypeEvent.challenges, 'season_challenges reuses the season-type event\'s own challenges array');
    assert.equal(season10.season_challenges[0].challenge_id, 70);
  });
});

test('GET /seasons: only_enabled_challenges=false includes the disabled challenge', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?season_id=10&only_enabled_challenges=false', ALICE);
    const body = await res.json();
    const event100 = body.data[0].events.find((e) => e.season_event_id === 100);
    assert.ok(event100.challenges.map((c) => c.challenge_id).includes(2));
  });
});

test('GET /seasons: include_completed_challenges=false drops the completed challenge', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?season_id=10&include_completed_challenges=false', ALICE);
    const body = await res.json();
    const event100 = body.data[0].events.find((e) => e.season_event_id === 100);
    assert.ok(!event100.challenges.map((c) => c.challenge_id).includes(3));
  });
});

test('GET /seasons: include_challenges=false -> no challenges or season_challenges keys anywhere', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?season_id=10&include_challenges=false', ALICE);
    const body = await res.json();
    const season = body.data[0];
    assert.ok(!('season_challenges' in season));
    assert.ok(!('challenges' in season.events[0]));
  });
});

test('GET /seasons: only_current_season drops the non-current season 30', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?only_current_season=true', ALICE);
    const body = await res.json();
    assert.deepEqual(body.data.map((s) => s.season_id), [10]);
  });
});

test('GET /seasons: include_internal_seasons=true surfaces the hidden season', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?include_internal_seasons=true&season_id=20', ALICE);
    const body = await res.json();
    assert.deepEqual(body.data.map((s) => s.season_id), [20]);
  });
});

test('GET /seasons: unknown season_id -> 422', async () => {
  await withServer({}, async (base) => {
    const res = await getJson(base, '/api/v4/mobile/seasons?season_id=999999', ALICE);
    assert.equal(res.status, 422);
  });
});

// ─── POST /zkpassport/complete (SPEC 2092-2141, 2939, 2961-2973) ────────

test('zkpassport: happy path -> 201, activity row with points/metadata, source=zkpassport', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => bridgeResponse({ verified: true }), async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 7, session_id: 'sess-heidi-7', nullifier_hex: '0xdead1007', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.data.already_recorded, false);
      assert.equal(body.data.completion_id, body.data.activity_id, 'completion_id IS the activity id');
      assert.equal(body.data.session_id, 'sess-heidi-7');
      assert.equal(body.data.nullifier_hex, '0xdead1007');
      assert.equal(body.data.leaderboard_refreshed, false);
      assert.ok(body.data.verified_at);
      assert.ok(body.data.completed_at);

      const stored = userActivities.find((a) => a.id === body.data.activity_id);
      assert.equal(stored.points, '10.00', 'points from the effective reward (template\'s 10)');
      assert.equal(stored.metadata.kind, 'challenge_completion');
      assert.equal(stored.metadata.session_id, 'sess-heidi-7');
      assert.equal(stored.metadata.wallet_address, 'wallet_heidi_100');
    });
  });
});

test('zkpassport: credential revoked during verification cannot cross the final write fence', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => {
      nativeCredentialActiveAtWrite = false;
      return bridgeResponse({ verified: true });
    }, async () => {
      const before = userActivities.length;
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 7,
        session_id: 'sess-revoked-at-write',
        nullifier_hex: '0xdead1008',
        wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 401);
      assert.equal(userActivities.length, before);
    });
  });
});

test('zkpassport: idempotent — existing (user, challenge) completion short-circuits BEFORE any bridge call', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    let bridgeCalls = 0;
    await withFetchMock(async () => { bridgeCalls += 1; return bridgeResponse({ verified: true }); }, async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 1, session_id: 'sess-new-value', nullifier_hex: '0xdeadface', wallet_address: 'wallet_carol_100',
      }, CAROL);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.already_recorded, true);
      assert.equal(body.data.completion_id, 1, 'the ORIGINAL activity row, not a new one');
      assert.equal(body.data.session_id, 'sess-carol-1', 'the ORIGINAL session_id, not the replayed request\'s');
      assert.equal(bridgeCalls, 0, 'idempotent short-circuit happens before any bridge call');
    });
  });
});

test('zkpassport: challenge not found -> 404', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 999999, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'w',
    }, HEIDI);
    assert.equal(res.status, 404);
  });
});

test('zkpassport: disabled challenge -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 2, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 422);
  });
});

test('zkpassport: completed challenge -> 409 no longer accepting', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 3, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 409);
  });
});

test('zkpassport: window already ended -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 4, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 422);
  });
});

test('zkpassport: window not started -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 5, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 422);
  });
});

test('zkpassport: user not enrolled -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 1, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'whatever',
    }, ERIN);
    assert.equal(res.status, 422);
  });
});

test('zkpassport: wallet mismatch vs the user\'s own account for this event -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 1, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_not_daves',
    }, DAVE);
    assert.equal(res.status, 422);
  });
});

test('zkpassport: session already used by a different completion -> 409', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 7, session_id: 'sess-taken', nullifier_hex: '0xdead1234', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 409);
  });
});

test('zkpassport: nullifier already claimed for this challenge -> 409', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 8, session_id: 'sess-fresh', nullifier_hex: '0xdeadbeef', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 409);
  });
});

test('zkpassport: reward missing/non-numeric -> 500', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 6, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 500);
  });
});

test('zkpassport: bridge not configured -> 500', async () => {
  await withServer({}, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 7, session_id: 's', nullifier_hex: '0xabc', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /not configured/);
  });
});

test('zkpassport: bridge request failure -> 502', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => { throw new Error('ECONNREFUSED'); }, async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 7, session_id: 's-502a', nullifier_hex: '0x502a', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 502);
    });
  });
});

test('zkpassport: bridge unexpected payload -> 502', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => bridgeResponse({ nonsense: true }), async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 7, session_id: 's-502b', nullifier_hex: '0x502b', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 502);
    });
  });
});

test('zkpassport: bridge reports verified:false -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => bridgeResponse({ verified: false }), async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 7, session_id: 's-422', nullifier_hex: '0x422', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 422);
    });
  });
});

test('zkpassport: unique-violation on the nullifier index at insert time -> mapped to 409', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => bridgeResponse({ verified: true }), async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 9, session_id: 's-race-1', nullifier_hex: '0xdead0001', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /already been claimed/);
    });
  });
});

test('zkpassport: unique-violation on the completion index at insert time -> mapped to 409', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    await withFetchMock(async () => bridgeResponse({ verified: true }), async () => {
      const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
        challenge_id: 9, session_id: 's-race-2', nullifier_hex: '0xdead0002', wallet_address: 'wallet_heidi_100',
      }, HEIDI);
      assert.equal(res.status, 409);
      assert.match((await res.json()).error, /already been completed/);
    });
  });
});

test('zkpassport: missing required fields -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {}, HEIDI);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.challenge_id);
    assert.ok(body.details.session_id);
    assert.ok(body.details.nullifier_hex);
    assert.ok(body.details.wallet_address);
  });
});

test('zkpassport: malformed nullifier_hex -> 422', async () => {
  await withServer({ topochainZkBridgeUrl: BRIDGE_URL }, async (base) => {
    const res = await postJson(base, '/api/v4/mobile/zkpassport/complete', {
      challenge_id: 7, session_id: 's', nullifier_hex: 'not-hex', wallet_address: 'wallet_heidi_100',
    }, HEIDI);
    assert.equal(res.status, 422);
  });
});
