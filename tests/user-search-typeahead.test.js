// GET /api/users/search — the platform's own collaborator / app-admin
// invite typeahead (src/routes/collaborators.js).
//
// #1195 moved its matching, LIKE escaping, ordering and projection onto
// the shared services/user-directory.js so the app-facing directory
// endpoints cannot drift from it. That refactor must be exactly
// behaviour-preserving, which is what this file pins:
//
//   • the wire shape stays { users: [...] } — no has_more, which the
//     four call sites in features/dialogs/members-controller.js and the
//     Dev-screen typeahead in public/js/app-view.js do not read,
//   • the cap stays 10,
//   • `excludeApp=<slug>` still resolves to an app id and still filters
//     out users who already hold a row on that app — this endpoint is
//     the one directory surface that MAY answer a membership question,
//     because it is gated on the platform's own session,
//   • an empty query still short-circuits to an empty list without
//     touching the database.
//
// #2521 then narrowed that membership answer to callers ENTITLED to it.
// `excludeApp` used to resolve through a bare `SELECT id FROM apps WHERE
// slug = $1` with no access check, so a caller who is not a member of a
// private app could diff the same search with and without
// `excludeApp=<private slug>` and read off which returned handles
// collaborate on it (snait reproduced exactly that at the handler level
// on the issue). It now resolves through appAccess.getAppForUser at the
// 'collab' level, and an inaccessible slug is SILENTLY ignored — the
// search runs unfiltered, with no 403/404 to confirm the app exists.
// The route also carries the same userDirectoryLimiter as its
// app-directory sibling.
//
// Run with: node --test tests/user-search-typeahead.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

// World shared by every test below. `tier-lists` is collab-public (the
// ordinary case the typeahead was written for); `secret-app` is
// collab-private and stands in for snait's repro app 77.
const APPS = [
  { id: 7, slug: 'tier-lists', created_by: 1, self_hosted: false, collab_visibility: 'public', view_visibility: 'public' },
  { id: 77, slug: 'secret-app', created_by: 1, self_hosted: false, collab_visibility: 'private', view_visibility: 'private' },
];

const state = {
  users: [],
  // app id -> Map(user id -> 'member' | 'invited')
  members: new Map(),
  queries: [],
  lastSearchParams: null,
};

function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const s = String(sql);
    state.queries.push(s);
    // appAccess.getAppForUser's row lookup (ACCESS_COLUMNS projection).
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      const app = APPS.find((a) => a.slug === params[0]);
      return { rows: app ? [{ ...app }] : [] };
    }
    // appAccess.isCollaborator — status='member' only.
    if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(s)) {
      const status = state.members.get(params[0])?.get(params[1]);
      return { rows: status === 'member' ? [{ '?column?': 1 }] : [] };
    }
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      state.lastSearchParams = params;
      const prefix = unescapeLike(params[0]).toLowerCase();
      const excludeAppId = params[1];
      // The messages-scope query hardcodes LIMIT 10 and carries the
      // self/block exclusions in $3/$4; the shared prefix helper passes
      // its limit as $3 instead.
      const isMessages = /user_blocks/.test(s);
      const limit = isMessages ? 10 : params[2];
      const selfId = isMessages ? params[3] : null;
      // The filter excludes ANY row on the app — members and invitees.
      const excluded = excludeAppId != null
        ? new Set((state.members.get(excludeAppId) || new Map()).keys())
        : new Set();
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix))
        .filter((u) => !excluded.has(u.id))
        .filter((u) => u.id !== selfId)
        .sort((a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || (a.id - b.id))
        .slice(0, limit);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
});

const { collaboratorRoutes } = require('../src/routes/collaborators');
const express = require('express');

let server;
test.before(async () => {
  const app = express();
  // Stand-in for authMiddleware. Identity comes from headers so the
  // limiter test can isolate itself on its own per-user bucket.
  app.use((req, _res, next) => {
    req.user = {
      id: Number(req.headers['x-user-id'] || 100),
      username: String(req.headers['x-username'] || 'viewer'),
      isAdmin: req.headers['x-is-admin'] === '1',
    };
    next();
  });
  app.use(collaboratorRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function search(qs = '', headers = {}) {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/users/search${qs}`,
    { headers }
  );
  return { status: res.status, body: await res.json() };
}

test.beforeEach(() => {
  state.users = [];
  state.members = new Map();
  state.queries = [];
  state.lastSearchParams = null;
});

test('the response shape is { users } — no has_more', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { status, body } = await search('?q=ali');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ['users']);
  assert.deepEqual(body.users, [{ id: 1, username: 'alice' }]);
});

test('an empty query short-circuits without touching the database', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  for (const qs of ['', '?q=', '?q=%20%20']) {
    state.queries = [];
    const { status, body } = await search(qs);
    assert.equal(status, 200);
    assert.deepEqual(body, { users: [] });
    assert.deepEqual(state.queries, []);
  }
});

test('the cap stays at 10', async () => {
  state.users = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, username: `user${String(i).padStart(2, '0')}`,
  }));
  const { body } = await search('?q=user');
  assert.equal(body.users.length, 10);
  // limit + 1 is fetched so the shared helper can compute has_more; the
  // extra row is dropped before it reaches the wire.
  assert.equal(state.lastSearchParams[2], 11);
});

test('excludeApp filters out users already on that app', async () => {
  state.users = [{ id: 1, username: 'alice' }, { id: 2, username: 'alina' }];
  state.members.set(7, new Map([[1, 'member']]));
  const { body } = await search('?q=ali&excludeApp=tier-lists');
  assert.equal(state.lastSearchParams[1], 7);
  assert.deepEqual(body.users.map((u) => u.username), ['alina']);
});

test('an unknown excludeApp slug degrades to no filter', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { body } = await search('?q=ali&excludeApp=no-such-app');
  assert.equal(state.lastSearchParams[1], null);
  assert.deepEqual(body.users.map((u) => u.username), ['alice']);
});

test('LIKE metacharacters are still escaped', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const { body } = await search('?q=%25');
  assert.deepEqual(body.users, []);
  assert.equal(state.lastSearchParams[0], '\\%');
});

test('the query is still clipped to 32 characters', async () => {
  await search(`?q=${'a'.repeat(50)}`);
  assert.equal(state.lastSearchParams[0].length, 32);
});

// ── #2521: excludeApp is access-gated ──────────────────────────────────

// snait's repro, as a regression test: attacker(2) is not a member of
// private app secret-app(77); alice(10) is. Without the gate, the
// exclusion fired for the attacker too and alice's disappearance from
// the second response was the membership oracle.
test('a non-member gets NO exclusion from a collab-private app (the leak)', async () => {
  state.users = [{ id: 10, username: 'alice' }, { id: 11, username: 'amir' }];
  state.members.set(77, new Map([[10, 'member']]));
  const attacker = { 'x-user-id': '2', 'x-username': 'attacker' };

  const plain = await search('?q=a&scope=messages', attacker);
  const excluded = await search('?q=a&excludeApp=secret-app&scope=messages', attacker);

  // Identical results is the whole point: no diff, no oracle.
  assert.deepEqual(plain.body.users.map((u) => u.username), ['alice', 'amir']);
  assert.deepEqual(excluded.body.users.map((u) => u.username), ['alice', 'amir']);
  assert.equal(state.lastSearchParams[1], null, 'excludeAppId must not resolve');
});

test('the refusal is silent — 200 with results, never 403/404', async () => {
  state.users = [{ id: 10, username: 'alice' }];
  state.members.set(77, new Map([[10, 'member']]));
  const attacker = { 'x-user-id': '2' };

  const real = await search('?q=a&excludeApp=secret-app', attacker);
  const fake = await search('?q=a&excludeApp=no-such-private-app', attacker);

  // A caller cannot tell an existing private app from a nonexistent one.
  assert.equal(real.status, 200);
  assert.equal(fake.status, 200);
  assert.deepEqual(real.body, fake.body);
});

test('a member of the private app still gets the exclusion', async () => {
  state.users = [{ id: 10, username: 'alice' }, { id: 11, username: 'amir' }];
  // The caller (5) is a member, so they may ask the membership question.
  state.members.set(77, new Map([[10, 'member'], [5, 'member']]));
  const { body } = await search('?q=a&excludeApp=secret-app', { 'x-user-id': '5' });
  assert.equal(state.lastSearchParams[1], 77);
  assert.deepEqual(body.users.map((u) => u.username), ['amir']);
});

test('a pending invite does not buy access, but is still excluded for members', async () => {
  state.users = [{ id: 10, username: 'alice' }, { id: 11, username: 'amir' }];
  state.members.set(77, new Map([[10, 'invited'], [5, 'member']]));

  // The invitee (10) holds a row but not membership — no access, no filter.
  const invitee = await search('?q=a&excludeApp=secret-app', { 'x-user-id': '10' });
  assert.equal(state.lastSearchParams[1], null);
  assert.deepEqual(invitee.body.users.map((u) => u.username), ['alice', 'amir']);

  // For a real member, an 'invited' row is still excluded from the
  // typeahead — you cannot re-invite someone with a pending invite.
  const member = await search('?q=a&excludeApp=secret-app', { 'x-user-id': '5' });
  assert.equal(state.lastSearchParams[1], 77);
  assert.deepEqual(member.body.users.map((u) => u.username), ['amir']);
});

test('admins keep the exclusion on any app', async () => {
  state.users = [{ id: 10, username: 'alice' }, { id: 11, username: 'amir' }];
  state.members.set(77, new Map([[10, 'member']]));
  const { body } = await search(
    '?q=a&excludeApp=secret-app', { 'x-user-id': '3', 'x-is-admin': '1' }
  );
  assert.equal(state.lastSearchParams[1], 77);
  assert.deepEqual(body.users.map((u) => u.username), ['amir']);
});

// ── #2521: the limiter ─────────────────────────────────────────────────

// Kept last: userDirectoryLimiter is a module singleton with a shared
// in-memory bucket, so exhausting it here must not starve the tests
// above. Its own bucket is keyed per user, so a dedicated id isolates it
// from them regardless of order.
test('the route carries the userDirectoryLimiter (120/min/user)', async () => {
  state.users = [{ id: 1, username: 'alice' }];
  const hammer = { 'x-user-id': '9521' };
  for (let i = 0; i < 120; i++) {
    const { status } = await search('?q=ali', hammer);
    assert.equal(status, 200, `request #${i + 1} should pass`);
  }
  const throttled = await search('?q=ali', hammer);
  assert.equal(throttled.status, 429);
  assert.match(throttled.body.error, /directory lookups/i);
  assert.equal(typeof throttled.body.retryAfterSeconds, 'number');
  // Throttles stay code-free so clients can discriminate billing 429s.
  assert.equal(throttled.body.code, undefined);

  // A different user has their own bucket.
  const other = await search('?q=ali', { 'x-user-id': '9522' });
  assert.equal(other.status, 200);
});
