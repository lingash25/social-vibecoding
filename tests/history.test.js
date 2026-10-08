// Tests for GET /api/me/history (src/routes/kudos.js) — the "My
// history" feed of everything the caller has given: PR kudos, issue
// bounty pledges, PR votes, and proposal (issue) votes.
//
// Same harness style as tests/kudos.test.js: kudosRoutes(config) is
// mounted on a throwaway Express app with getPool() swapped for an
// in-memory mock that pattern-matches the SQL. The history endpoint
// issues a single UNION ALL whose arms are detected by their literal
// `'<type>' AS type` tags, so the mock can tell which arms the route
// included for a given ?type= filter.
//
// Run with: node --test tests/history.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// ─── module-cache pool/ws stubbing (same trick as kudos.test.js) ──

function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  const stub = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  require.cache[poolModulePath] = stub;
  delete require.cache[require.resolve('../src/routes/kudos')];
  const wsPath = require.resolve('../src/services/ws');
  const origWs = require.cache[wsPath];
  require.cache[wsPath] = {
    exports: {
      pushNotificationToUser: () => 0,
      pushKudosUpdate: () => {},
    },
    loaded: true,
    id: wsPath,
    filename: wsPath,
    paths: origWs ? origWs.paths : [],
  };
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    if (origWs) require.cache[wsPath] = origWs;
    else delete require.cache[wsPath];
    delete require.cache[require.resolve('../src/routes/kudos')];
  }
}

// ─── in-memory mock pool for the history UNION ALL ────────────────
//
// State mirrors the four ledgers + their join targets. The history
// query is recognized by its trailing `ORDER BY created_at DESC LIMIT
// $n`; which arms to evaluate is read off the SQL itself (the route
// only includes the arms the ?type= filter asked for), as is the
// presence of the keyset cursor (`created_at < $2`).
function makeHistoryPool(seed = {}) {
  const state = {
    apps: new Map(seed.apps || []),         // id => { slug, name }
    users: new Map(seed.users || []),       // id => { username }
    sessions: new Map(seed.sessions || []), // id => { id, user_id, status, app_id, pr_number, pr_title }
    issues: new Map(seed.issues || []),     // id => { id, app_id, github_issue_number, title, kind, status }
    kudos: seed.kudos || [],                // { session_id, giver_user_id, created_at }
    bounties: seed.bounties || [],          // { app_id, github_issue_number, giver_user_id, status, awarded_user_id, awarded_at, created_at }
    prVotes: seed.prVotes || [],            // { session_id, user_id, vote, created_at }
    issueVotes: seed.issueVotes || [],      // { issue_id, user_id, vote, created_at }
  };

  async function query(sql, params = []) {
    const s = String(sql);
    if (/ORDER BY created_at DESC/i.test(s) && /LIMIT \$\d+/i.test(s)) {
      const userId = params[0];
      const hasBefore = /created_at < \$2/.test(s);
      const before = hasBefore ? Date.parse(params[1]) : null;
      const limit = params[params.length - 1];
      const app = (id) => state.apps.get(id) || { slug: 'app', name: 'App' };
      const uname = (id) =>
        id != null && state.users.has(id) ? state.users.get(id).username : null;
      const blank = {
        vote: null, status: null, session_id: null, pr_number: null,
        pr_title: null, author_username: null, issue_number: null,
        issue_title: null, issue_kind: null, awarded_username: null,
        awarded_at: null,
      };
      const rows = [];

      if (s.includes(`'kudos' AS type`)) {
        for (const k of state.kudos) {
          if (k.giver_user_id !== userId) continue;
          const cs = state.sessions.get(k.session_id);
          if (!cs) continue; // inner JOIN chat_sessions
          const a = app(cs.app_id);
          rows.push({
            ...blank, type: 'kudos', created_at: k.created_at,
            status: cs.status, session_id: cs.id,
            pr_number: cs.pr_number ?? null, pr_title: cs.pr_title ?? null,
            author_username: uname(cs.user_id),
            app_slug: a.slug, app_name: a.name,
          });
        }
      }
      if (s.includes(`'bounty' AS type`)) {
        for (const b of state.bounties) {
          if (b.giver_user_id !== userId) continue;
          const a = app(b.app_id);
          rows.push({
            ...blank, type: 'bounty', created_at: b.created_at,
            status: b.status, issue_number: b.github_issue_number,
            awarded_username: uname(b.awarded_user_id),
            awarded_at: b.awarded_at ?? null,
            app_slug: a.slug, app_name: a.name,
          });
        }
      }
      if (s.includes(`'pr_vote' AS type`)) {
        for (const v of state.prVotes) {
          if (v.user_id !== userId) continue;
          const cs = state.sessions.get(v.session_id);
          if (!cs) continue;
          const a = app(cs.app_id);
          rows.push({
            ...blank, type: 'pr_vote', created_at: v.created_at,
            vote: v.vote, status: cs.status, session_id: cs.id,
            pr_number: cs.pr_number ?? null, pr_title: cs.pr_title ?? null,
            author_username: uname(cs.user_id),
            app_slug: a.slug, app_name: a.name,
          });
        }
      }
      if (s.includes(`'proposal_vote' AS type`)) {
        for (const v of state.issueVotes) {
          if (v.user_id !== userId) continue;
          const issue = state.issues.get(v.issue_id);
          if (!issue) continue;
          const a = app(issue.app_id);
          rows.push({
            ...blank, type: 'proposal_vote', created_at: v.created_at,
            vote: v.vote, status: issue.status,
            issue_number: issue.github_issue_number ?? null,
            issue_title: issue.title, issue_kind: issue.kind,
            app_slug: a.slug, app_name: a.name,
          });
        }
      }

      let out = rows;
      if (before != null) out = out.filter((r) => Date.parse(r.created_at) < before);
      out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return { rows: out.slice(0, limit) };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }

  return { query, state };
}

// `user` may be null to exercise the 401 guard.
async function startTestServer(pool, user = { id: 1, username: 'alice' }) {
  return withMockPool(pool, async () => {
    const { kudosRoutes } = require('../src/routes/kudos');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use(kudosRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

// Standard seed: user 1 (alice, the caller) gave one of each thing at
// distinct, strictly increasing timestamps; user 2 (bob) authored the
// PRs. t() spaces entries a minute apart, newest = highest index.
function t(i) { return new Date(Date.UTC(2026, 4, 20, 10, i, 0)).toISOString(); }

function seedPool() {
  return makeHistoryPool({
    apps: [[1, { slug: 'cool-app', name: 'Cool App' }]],
    users: [[1, { username: 'alice' }], [2, { username: 'bob' }]],
    sessions: [
      [10, { id: 10, user_id: 2, status: 'merged', app_id: 1, pr_number: 7, pr_title: 'Add widgets' }],
      [11, { id: 11, user_id: 2, status: 'promoted', app_id: 1, pr_number: 8, pr_title: 'Fix gadgets' }],
    ],
    issues: [
      [5, { id: 5, app_id: 1, github_issue_number: 42, title: 'Rename to Cooler App', kind: 'rename', status: 'open' }],
    ],
    kudos: [{ session_id: 10, giver_user_id: 1, created_at: t(4) }],
    bounties: [{
      app_id: 1, github_issue_number: 99, giver_user_id: 1, status: 'open',
      awarded_user_id: null, awarded_at: null, created_at: t(3),
    }],
    prVotes: [{ session_id: 11, user_id: 1, vote: 'yes', created_at: t(2) }],
    issueVotes: [{ issue_id: 5, user_id: 1, vote: 'up', created_at: t(1) }],
  });
}

// ─── tests ─────────────────────────────────────────────────────────

test('GET /api/me/history: 401 without auth', async () => {
  const { baseUrl, close } = await startTestServer(seedPool(), null);
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});

test('merged feed: all four types, strict reverse-chronological order', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(
      data.items.map((i) => i.type),
      ['kudos', 'bounty', 'pr_vote', 'proposal_vote']
    );
    for (let i = 1; i < data.items.length; i++) {
      assert.ok(
        Date.parse(data.items[i - 1].created_at) > Date.parse(data.items[i].created_at),
        'items strictly newest-first'
      );
    }
    // Spot-check normalization per type.
    const [kudos, bounty, prVote, propVote] = data.items;
    assert.equal(kudos.pr.title, 'Add widgets');
    assert.equal(kudos.pr.number, 7);
    assert.equal(kudos.pr.author, 'bob');
    assert.deepEqual(kudos.app, { slug: 'cool-app', name: 'Cool App' });
    assert.equal(bounty.issue.number, 99);
    assert.equal(bounty.status, 'open');
    assert.equal(bounty.awarded, undefined, 'open bounty has no awarded block');
    assert.equal(prVote.vote, 'yes');
    assert.equal(prVote.pr.title, 'Fix gadgets');
    assert.equal(propVote.vote, 'up');
    assert.equal(propVote.issue.title, 'Rename to Cooler App');
    assert.equal(propVote.issue.kind, 'rename');
    // Page came back short of the default 50 — no further pages.
    assert.equal(data.nextBefore, null);
  } finally {
    await close();
  }
});

test('#4003: a change still up for a vote carries what it waits on; others do not', async () => {
  const pool = seedPool();
  pool.state.sessions.get(11).check_state = 'pending';
  const baseQuery = pool.query;
  const asked = [];
  pool.query = async (sql, params = []) => {
    if (/FROM chat_sessions/.test(String(sql)) && /status = 'promoted'/.test(String(sql))) {
      asked.push(params[0]);
      return { rows: params[0].map((id) => pool.state.sessions.get(id))
        .filter((cs) => cs && cs.status === 'promoted') };
    }
    return baseQuery(sql, params);
  };
  const govPath = require.resolve('../src/services/governance');
  const original = require.cache[govPath];
  const gates = [];
  require.cache[govPath] = {
    id: govPath, filename: govPath, loaded: true, paths: [],
    exports: {
      governedGate: async (_pool, appId, opts) => {
        gates.push({ appId, ...opts });
        return { qualifiedYes: 1, required: 3, mergeable: false, lazyArmed: false, memberFloor: null };
      },
    },
  };
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    assert.deepEqual(asked, [[11]], 'only the promoted vote is looked up');
    assert.equal(gates[0].appId, 1);
    assert.equal(gates[0].id, 11);
    const prVote = data.items.find((i) => i.type === 'pr_vote');
    assert.deepEqual(prVote.progress, {
      checkState: 'pending', yes: 1, required: 3, votesDone: false, lazy: false, needsMember: false,
    });
    assert.equal(data.items.find((i) => i.type === 'proposal_vote').progress, undefined);
  } finally {
    await close();
    if (original) require.cache[govPath] = original;
    else delete require.cache[govPath];
  }
});

test('#4003: the vote list still answers when the progress lookup fails', async () => {
  // The seed's mock pool throws on any query it does not know, which is
  // exactly what the progress lookup is to it.
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const r = await fetch(`${baseUrl}/api/me/history?type=votes`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.items.find((i) => i.type === 'pr_vote').progress, undefined);
  } finally {
    await close();
  }
});

test('type=kudos returns only the kudos + bounty arms', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    assert.deepEqual(data.items.map((i) => i.type), ['kudos', 'bounty']);
  } finally {
    await close();
  }
});

test('type=votes returns only the two vote arms', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    assert.deepEqual(data.items.map((i) => i.type), ['pr_vote', 'proposal_vote']);
  } finally {
    await close();
  }
});

test('pagination: limit + before cursor pages with no overlap', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const page1 = await (await fetch(`${baseUrl}/api/me/history?limit=2`)).json();
    assert.equal(page1.items.length, 2);
    assert.deepEqual(page1.items.map((i) => i.type), ['kudos', 'bounty']);
    assert.ok(page1.nextBefore, 'full page exposes a cursor');
    assert.equal(page1.nextBefore, page1.items[1].created_at);

    const page2 = await (await fetch(
      `${baseUrl}/api/me/history?limit=2&before=${encodeURIComponent(page1.nextBefore)}`
    )).json();
    assert.deepEqual(page2.items.map((i) => i.type), ['pr_vote', 'proposal_vote']);
    const seen = new Set(page1.items.map((i) => `${i.type}|${i.created_at}`));
    for (const it of page2.items) {
      assert.ok(!seen.has(`${it.type}|${it.created_at}`), 'no overlap across pages');
    }
    // page2 was also full, so it carries a cursor — the next page is empty.
    assert.ok(page2.nextBefore);
    const page3 = await (await fetch(
      `${baseUrl}/api/me/history?limit=2&before=${encodeURIComponent(page2.nextBefore)}`
    )).json();
    assert.equal(page3.items.length, 0);
    assert.equal(page3.nextBefore, null);
  } finally {
    await close();
  }
});

test('400 on a garbage before timestamp', async () => {
  const { baseUrl, close } = await startTestServer(seedPool());
  try {
    const r = await fetch(`${baseUrl}/api/me/history?before=not-a-date`);
    assert.equal(r.status, 400);
  } finally {
    await close();
  }
});

test('scoping: another user’s gives never appear', async () => {
  const pool = seedPool();
  // bob (id 2) also gave a kudos, a bounty, and both vote kinds — none
  // of it may leak into alice's feed.
  pool.state.kudos.push({ session_id: 11, giver_user_id: 2, created_at: t(9) });
  pool.state.bounties.push({
    app_id: 1, github_issue_number: 50, giver_user_id: 2, status: 'open',
    awarded_user_id: null, awarded_at: null, created_at: t(8),
  });
  pool.state.prVotes.push({ session_id: 10, user_id: 2, vote: 'no', created_at: t(7) });
  pool.state.issueVotes.push({ issue_id: 5, user_id: 2, vote: 'down', created_at: t(6) });
  const { baseUrl, close } = await startTestServer(pool, { id: 1, username: 'alice' });
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history`)).json();
    assert.equal(data.items.length, 4, 'only alice’s own four entries');
    assert.ok(!data.items.some((i) => i.vote === 'no' || i.vote === 'down'));
    assert.ok(!data.items.some((i) => i.issue?.number === 50));
  } finally {
    await close();
  }
});

test('vote-flip: one row with the new vote and the updated timestamp', async () => {
  const pool = seedPool();
  // The vote route upserts (ON CONFLICT ... SET vote, created_at=NOW())
  // — simulate the flip by mutating the single standing row in place.
  const v = pool.state.prVotes[0];
  v.vote = 'no';
  v.created_at = t(5);
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const data = await (await fetch(`${baseUrl}/api/me/history?type=votes`)).json();
    const prVotes = data.items.filter((i) => i.type === 'pr_vote');
    assert.equal(prVotes.length, 1, 'only the current standing vote survives a flip');
    assert.equal(prVotes[0].vote, 'no');
    assert.equal(prVotes[0].created_at, t(5));
  } finally {
    await close();
  }
});

test('deleted PR author surfaces as null, not an error', async () => {
  const pool = seedPool();
  // chat_sessions.user_id is ON DELETE SET NULL — both the kudos and
  // the PR-vote arms LEFT JOIN users, so the row survives authorless.
  pool.state.sessions.get(10).user_id = null;
  pool.state.sessions.get(11).user_id = null;
  const { baseUrl, close } = await startTestServer(pool);
  try {
    const r = await fetch(`${baseUrl}/api/me/history`);
    assert.equal(r.status, 200);
    const data = await r.json();
    const kudos = data.items.find((i) => i.type === 'kudos');
    const prVote = data.items.find((i) => i.type === 'pr_vote');
    assert.equal(kudos.pr.author, null);
    assert.equal(prVote.pr.author, null);
  } finally {
    await close();
  }
});

test('awarded bounty carries the awarded block (and null for deleted awardee)', async () => {
  const pool = seedPool();
  pool.state.bounties[0].status = 'awarded';
  pool.state.bounties[0].awarded_user_id = 2;
  pool.state.bounties[0].awarded_at = t(10);
  const { baseUrl, close } = await startTestServer(pool);
  try {
    let data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    let bounty = data.items.find((i) => i.type === 'bounty');
    assert.equal(bounty.status, 'awarded');
    assert.deepEqual(bounty.awarded, { username: 'bob', at: t(10) });

    // Deleted awardee (ON DELETE SET NULL) → username null, no error.
    pool.state.bounties[0].awarded_user_id = null;
    data = await (await fetch(`${baseUrl}/api/me/history?type=kudos`)).json();
    bounty = data.items.find((i) => i.type === 'bounty');
    assert.equal(bounty.awarded.username, null);
  } finally {
    await close();
  }
});

test('/api/me/history is NOT in the auth middleware’s PUBLIC_PATHS', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(entries.length > 0, 'parsed at least one public path');
  for (const p of entries) {
    assert.ok(
      !'/api/me/history'.startsWith(p),
      `public prefix "${p}" must not expose /api/me/history`
    );
  }
});

// The challenge artwork directory is public for the same reason /icons/ is.
// The middleware matches by prefix, so the entry has to keep its trailing
// slash, and nothing that is a prefix of it (a bare "/" or "/i") may have come
// along with it.
test('/illustrations/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/illustrations') || '/illustrations/'.startsWith(p));
  assert.deepEqual(related, ['/illustrations/']);
});

// The signed-out landing's own artwork. Its whole audience is the tier that
// has no platform access, so the gate must not see the request at all: a 302
// to '/' in an <img> is a broken picture, which is what staging drew before
// this entry existed. Same shape as the two above.
test('/brand/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/brand') || '/brand/'.startsWith(p));
  assert.deepEqual(related, ['/brand/']);
});

// Uploaded challenge artwork decorates the same public cards, so its image
// route is public too, at its own prefix. Same shape as the entry above: the
// trailing slash stays, and nothing wider comes along with it.
test('/challenge-illustrations/ is in PUBLIC_PATHS, and nothing broader was opened with it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'),
    'utf8'
  );
  const m = src.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const related = entries.filter((p) => p.startsWith('/challenge') || '/challenge-illustrations/'.startsWith(p));
  assert.deepEqual(related, ['/challenge-illustrations/']);
});
