'use strict';

// The platform's ONE username-directory implementation (issue #1195).
//
// Three surfaces read it and must never drift apart:
//   • GET /api/app-platform/users/{lookup,search}  — app containers
//     (src/routes/app-platform-api.js), app token + user token.
//   • GET /api/app-directory/users/{lookup,search} — the shell's bridge
//     relay (src/routes/app-directory.js), browser session.
//   • GET /api/users/search                        — the platform's own
//     collaborator/app-admin invite typeahead (src/routes/collaborators.js).
//
// Plus one list that is not a search: GET /api/app-platform/members, the
// calling app's own people (listAppMembers below). All four leave out the
// same platform accounts (HIDDEN_USERNAMES and synthetic users).
//
// One matching rule, one escaping rule, one ordering rule, and — the
// point of the exercise — ONE projection. A directory answer is
// `{ id, username }` and nothing else: no display_name, bio, avatar,
// email, usernode_pubkey, locale, is_admin, created_at or profile_*
// column may ever join this SELECT list. `username` is the canonical route
// key and is already public; everything else on the users row is either
// private or gated behind the opt-in public-profile allowlist in
// src/routes/profiles.js. It stopped being IMMUTABLE when username changes landed — lookupExact
// resolves retired handles through src/services/usernames.js, and always
// answers with the current one.

// users.username is VARCHAR(255) — anything longer cannot match a row,
// so it is a bad request rather than a miss.
const MAX_USERNAME_LEN = 255;
// Retired-handle resolution for lookupExact (see the note there).
const usernames = require('./usernames');
// Prefix queries are clipped, matching the invite typeahead's own clip.
const MAX_QUERY_LEN = 32;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

// The complete field allowlist. Kept as a constant so the projection and
// the tests that guard it read from the same place.
const USER_FIELDS = ['id', 'username'];

// Accounts the directory never answers with: they are platform machinery,
// not people anyone could invite, mention or share a chore rota with.
//
//   • The `usernode-*` service identities (services/usernames.js
//     SERVICE_IDENTITIES). `usernode-capture-admin` signs every proposal
//     check, so it opens every preview; a 4 October 2026 first-session run
//     found its handle on a group's chore rota, "next: usernode-capture-admin".
//     `staging-demo-user` is in that set too but is left out of this one: it
//     exists only in a staging clone, whose user-directory fixtures
//     (migrate.js seedStagingUserDirectory) are `staging-demo-*` handles a
//     preview is meant to find.
//   • Synthetic users (`users.is_synthetic`): the Homeroom bot and a demo
//     recording's partner. Neither can sign in, and neither is a member of
//     anything in the sense an app means.
//
// Lower-cased, because every match below compares LOWER(username).
const HIDDEN_USERNAMES = Object.freeze(
  [...usernames.SERVICE_IDENTITIES]
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith('usernode'))
);

// Each query below leaves those accounts out with the same two clauses,
// written out in full (not built by a helper) so scripts/check-sql.js can
// still read every query as static SQL:
//   is_synthetic IS NOT TRUE AND LOWER(username) <> ALL($n::text[])
// with $n bound to HIDDEN_USERNAMES.

// Escape LIKE metacharacters so a literal %, _ or \ in the query can't
// widen a prefix match into a whole-table scan. Paired with an explicit
// ESCAPE '\' in every LIKE below.
function escapeLike(s) {
  return s.replace(/([\\%_])/g, '\\$1');
}

function projectUser(row) {
  return { id: row.id, username: row.username };
}

// Normalize a lookup handle. Returns null for anything that cannot be a
// username — callers turn that into a 400, so "no such handle" (200
// found:false) stays distinguishable from "you sent nonsense".
function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_USERNAME_LEN) return null;
  return trimmed;
}

// Normalize a prefix query: trim, clip. An empty result means "return
// nothing" — never "return the whole table".
function normalizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_QUERY_LEN);
}

// Absent/unparseable → the default; out of range → clamped to the bound.
function clampLimit(raw, { def = DEFAULT_SEARCH_LIMIT, max = MAX_SEARCH_LIMIT } = {}) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

// Exact-handle existence check, case-insensitively.
//
// users.username is UNIQUE, but Postgres uniqueness is case-SENSITIVE
// and registration (src/routes/auth.js) normalizes nothing, so
// case-collided pairs genuinely exist in production. Resolution:
//
//   1. A case-EXACT row wins outright (this is what login matches on).
//   2. Otherwise a single case-insensitive row is the answer.
//   3. Otherwise the lowest id is returned with `ambiguous: true`, so an
//      app can ask the user which one they meant instead of silently
//      inviting the wrong person.
//
// `username` in the reply is always the CANONICAL stored casing, so an
// app that persists it stores the handle the way its owner wrote it.
async function lookupExact(pool, username) {
  const name = normalizeUsername(username);
  if (name === null) return { found: false, user: null, ambiguous: false };

  // LIMIT 2 is all the collision rule needs: whether a second
  // case-insensitive row exists, and which row sorts first.
  const { rows } = await pool.query(
    `SELECT id, username FROM users
      WHERE LOWER(username) = LOWER($1)
        AND is_synthetic IS NOT TRUE AND LOWER(username) <> ALL($2::text[])
      ORDER BY (username = $1) DESC, id
      LIMIT 2`,
    [name, HIDDEN_USERNAMES]
  );
  if (rows.length) {
    const exact = rows[0].username === name;
    return {
      found: true,
      user: projectUser(rows[0]),
      ambiguous: !exact && rows.length > 1,
    };
  }

  // No live holder — try the retired-handle ledger. An app that
  // stored `@alice` last year must keep resolving her after she renamed;
  // that is the whole reason the handle stays reserved instead of returning
  // to the pool. Never ambiguous: `username_history` carries a unique index
  // on LOWER(username), so a retired handle has exactly one owner.
  //
  // The reply still projects the user's CANONICAL CURRENT handle, not the
  // one that was asked for, so an app that re-persists the answer converges
  // on the live name instead of pinning the old one forever.
  //
  // Deliberately NOT extended to searchPrefix below: a typeahead offering
  // handles nobody wears is a typeahead offering the wrong person.
  const resolved = await usernames.resolveHandle(pool, name);
  // resolveHandle tries the LIVE name first. A visible live holder was
  // already answered above, so a live hit here is a hidden account and
  // stays not found; only a retired handle resolves, and never to one.
  if (!resolved || !resolved.retired
      || HIDDEN_USERNAMES.includes(String(resolved.username).toLowerCase())) {
    return { found: false, user: null, ambiguous: false };
  }
  return {
    found: true,
    user: projectUser({ id: resolved.userId, username: resolved.username }),
    ambiguous: false,
  };
}

// Case-insensitive PREFIX search. Prefix-only on purpose: LIKE 'q%' is
// servable by an index — idx_users_username_lower_pattern on
// LOWER(username) in schema.sql (#1213); text_pattern_ops because a
// non-C collation's default opclass cannot turn a LIKE prefix into an
// index range — and matches what the platform's own typeahead has
// always done, while LIKE '%q%' turns every keystroke into a table scan.
//
// `excludeAppId` filters out users who already hold any app_collaborators
// row (member or invited) on that app — used only by the platform's own
// invite typeahead, which must not suggest people already on the list.
//
// `viewerId` is who is searching (#5104). A person who keeps their profile
// out of searches (users.profile_discoverable, off by default) is found
// only by people connected to them: friends, or people in the same project
// by consent on both sides, never just a shared public community
// (schema.sql user_consented_projects, users_connected). Without a viewer, only the
// people who opted in are found. lookupExact above is not filtered: it
// answers a handle the caller already knows, as a profile link does.
async function searchPrefix(pool, q, limit, opts = {}) {
  const prefix = normalizeQuery(q);
  if (!prefix) return { users: [], hasMore: false };

  const n = clampLimit(limit, opts);
  const escaped = escapeLike(prefix);
  const excludeAppId = opts.excludeAppId ?? null;
  const viewerId = opts.viewerId ?? null;

  // Fetch n+1 so an extra row signals there is more to find — the same
  // trick the governance feed uses for its cursor pages.
  const { rows } = await pool.query(
    `SELECT id, username FROM users
      WHERE LOWER(username) LIKE LOWER($1) || '%' ESCAPE '\\'
        AND ($2::int IS NULL OR id NOT IN (
          SELECT user_id FROM app_collaborators WHERE app_id = $2
        ))
        AND is_synthetic IS NOT TRUE AND LOWER(username) <> ALL($4::text[])
        AND user_discoverable_by(id, $5::int)
      ORDER BY LOWER(username), id
      LIMIT $3`,
    [escaped, excludeAppId, n + 1, HIDDEN_USERNAMES, viewerId]
  );

  let hasMore = false;
  if (rows.length > n) {
    hasMore = true;
    rows.length = n;
  }
  return { users: rows.map(projectUser), hasMore };
}

// Member list bounds: a group is a handful of people, and a public
// community's roster is paged by nobody today, so one generous page.
const DEFAULT_MEMBERS_LIMIT = 100;
const MAX_MEMBERS_LIMIT = 200;

// The people in an app's community: who "everyone in the group" means.
//
// An app had no way to ask this, so apps guessed it from the users they had
// seen, plus a staging fixture of fake people so previews were not empty. A
// preview then showed "Staging demo Maya's turn" and the check runner's
// handle instead of the group (first-session run, 4 October 2026). This is
// the real roster: `community_members` (services/communities.js), the same
// table the project page's community card names people from, in the order a
// rota wants: the creator, then everyone else oldest member first.
//
// Same `{ id, username }` projection as every directory answer, and the same
// hidden accounts. A person who has blocked the app (user_app_blocks) cannot
// open it, so they are not listed as one of its people either.
async function listAppMembers(pool, appId, limit) {
  const n = clampLimit(limit, { def: DEFAULT_MEMBERS_LIMIT, max: MAX_MEMBERS_LIMIT });
  const { rows } = await pool.query(
    `SELECT u.id, u.username
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
       JOIN users u ON u.id = m.user_id
      WHERE a.id = $1
        AND u.is_synthetic IS NOT TRUE AND LOWER(u.username) <> ALL($2::text[])
        AND NOT EXISTS (SELECT 1 FROM user_app_blocks b
                         WHERE b.user_id = u.id AND b.app_id = a.id)
      ORDER BY (m.source = 'creator') DESC, m.joined_at, u.id
      LIMIT $3`,
    [appId, HIDDEN_USERNAMES, n + 1]
  );
  let hasMore = false;
  if (rows.length > n) {
    hasMore = true;
    rows.length = n;
  }
  return { members: rows.map(projectUser), hasMore };
}

module.exports = {
  lookupExact,
  searchPrefix,
  listAppMembers,
  HIDDEN_USERNAMES,
  DEFAULT_MEMBERS_LIMIT,
  MAX_MEMBERS_LIMIT,
  normalizeUsername,
  normalizeQuery,
  clampLimit,
  escapeLike,
  projectUser,
  USER_FIELDS,
  MAX_USERNAME_LEN,
  MAX_QUERY_LEN,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
};
