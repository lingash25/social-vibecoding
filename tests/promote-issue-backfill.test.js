// Route test for POST /api/sessions/:id/promote (src/routes/votes.js) —
// #2500 / #2537, the originating-issue backfill.
//
// Starting a dev chat from an issue card recorded the number in
// chat_sessions.created_from_issue_number only. The issue board linked back
// to the session from there (services/issue-proposal-ref.js unions the
// column in), but the proposal's own "Addresses" chips and the deterministic
// `Closes #N` block both read chat_sessions.linked_issues, which nothing
// wrote unless the Mayor declared the link with `addresses_issues` — and an
// OpenRouter or direct-agent turn emits no Mayor tool at all. So the
// proposal read "No issues linked yet" and merging it closed nothing.
//
// Sessions created since carry the link from the INSERT (see
// tests/create-session-issue-link.test.js). Promote time is where the rows
// that predate that get repaired, and what is pinned here:
//   1. An unseeded row with an originating issue and no linkage gets the
//      issue linked, through proposal-update.updateLinkedIssues so a
//      session that already has a pull request gets `Closes #N` appended to
//      its live body too, and is then marked seeded.
//   2. A SEEDED row with empty linkage is left alone: that emptiness is an
//      author who removed the issue, and resurrecting it would make the
//      linked-issues editor look broken.
//   3. A row that already links something is left alone.
//   4. The backfill is best-effort — a failure inside it never stops the
//      proposal going up for a vote.
//
// Same require.cache + Router-recorder stubbing as
// tests/promote-cap-enforcement.test.js. Nothing real spins up.
//
// Run with: node --test tests/promote-issue-backfill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

const routes = new Map();
function makeRouterStub() {
  const router = {};
  for (const method of ['use', 'get', 'post', 'put', 'delete', 'patch']) {
    router[method] = (path, ...handlers) => {
      if (typeof path === 'string' && handlers.length) {
        routes.set(`${method.toUpperCase()} ${path}`, handlers[handlers.length - 1]);
      }
      return router;
    };
  }
  return router;
}

const Module = require('module');
Module._load = (function (orig) {
  return function (request, ...rest) {
    if (request === 'express') return { Router: makeRouterStub };
    return orig.call(this, request, ...rest);
  };
})(Module._load);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function sessionRow(overrides = {}) {
  return {
    id: 7,
    app_id: 5,
    user_id: 3,
    status: 'active',
    is_headless: false,
    branch_name: 'dev/evan-1',
    pr_number: null,
    pr_title: null,
    created_from_issue_number: 2496,
    linked_issues: [],
    issue_link_seeded: false,
    app_slug: 'whiteboard',
    app_name: 'Whiteboard',
    repo_url: 'https://github.com/acme/whiteboard',
    ...overrides,
  };
}

// `row` is the session the promote reads. `onUpdateLinkedIssues` lets a
// test make the backfill blow up.
function loadPromote({ row, onUpdateLinkedIssues }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    proposalUpdate: require.resolve('../src/services/proposal-update'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const seen = { linkCalls: [], seededWrites: [], prCreated: false };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/FROM chat_sessions cs JOIN apps a/.test(s)) return { rows: [row], rowCount: 1 };
      if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/.test(s)) return { rows: [{ cnt: '0' }], rowCount: 1 };
      if (/UPDATE chat_sessions SET issue_link_seeded/.test(s)) {
        seen.seededWrites.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM chat_session_messages/.test(s)) return { rows: [{ content: 'add a thing' }], rowCount: 1 };
      return { rows: [], rowCount: 0, params };
    },
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => false,
    describeGithubError: (err) => ({
      status: null, requestId: null, message: (err && err.message) || 'unknown error', data: null,
    }),
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, {
    sendSystemMessage: async () => {}, pushNotificationToUser() {},
    pushVoteUpdate() {}, pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => false });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.stagingRecovery, {
    recheckSessionChecks: async () => 'rechecked',
    rebuildSessionStaging: async () => 'skipped',
    stagingNeedsRebuild: async () => false,
  });
  stub(ids.proposalUpdate, {
    async updateLinkedIssues(args) {
      seen.linkCalls.push(args);
      if (onUpdateLinkedIssues) return onUpdateLinkedIssues(args);
      args.session.linked_issues = args.addIssues.slice();
      return { changed: true, linkedIssues: args.addIssues.slice() };
    },
    repoNameFromUrl: () => 'acme/whiteboard',
  });
  stub(ids.prMetadata, {
    applyPrMetadata: async () => {
      seen.prCreated = true;
      // Stop the promote at the next gate: we only care that the backfill
      // ran first, not that a whole promote succeeds under stubs.
      const err = new Error('stubbed: no GitHub in this test');
      err.code = 'no_commits';
      throw err;
    },
    sanitizeIssueNumbers: (a) => (Array.isArray(a) ? a.filter((n) => Number.isInteger(n) && n > 0) : []),
  });

  routes.clear();
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  subject.voteRoutes({});
  const promote = routes.get('POST /api/sessions/:id/promote');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { promote, seen, restore };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const USER = { id: 3, username: 'evan' };

async function promoteWith(opts) {
  const ctx = loadPromote(opts);
  try {
    const res = makeRes();
    await ctx.promote({ params: { id: '7' }, user: USER, body: {} }, res);
    return { status: res.statusCode, body: res.body, seen: ctx.seen, row: opts.row };
  } finally {
    ctx.restore();
  }
}

test('an unseeded issue-started proposal gets its originating issue linked at promote', async () => {
  const row = sessionRow();
  const { seen } = await promoteWith({ row });
  assert.equal(seen.linkCalls.length, 1, 'the backfill ran');
  assert.deepEqual(seen.linkCalls[0].addIssues, [2496]);
  assert.deepEqual(seen.linkCalls[0].removeIssues, []);
  assert.equal(seen.linkCalls[0].owner, 'acme');
  assert.equal(seen.linkCalls[0].repo, 'whiteboard');
  assert.deepEqual(row.linked_issues, [2496], 'the row carries the link into PR creation');
  assert.equal(seen.seededWrites.length, 1, 'and is marked seeded');
  assert.deepEqual(seen.seededWrites[0], [7]);
  assert.ok(seen.prCreated, 'the backfill runs BEFORE the pull request is opened');
});

test('a seeded proposal with no linked issues is left alone (a deliberate removal stays removed)', async () => {
  const row = sessionRow({ issue_link_seeded: true });
  const { seen } = await promoteWith({ row });
  assert.equal(seen.linkCalls.length, 0);
  assert.equal(seen.seededWrites.length, 0);
  assert.deepEqual(row.linked_issues, []);
});

test('a proposal that already links issues is left alone', async () => {
  const row = sessionRow({ linked_issues: [900] });
  const { seen } = await promoteWith({ row });
  assert.equal(seen.linkCalls.length, 0);
  assert.deepEqual(row.linked_issues, [900]);
});

test('a proposal with no originating issue has nothing to backfill', async () => {
  const row = sessionRow({ created_from_issue_number: null });
  const { seen } = await promoteWith({ row });
  assert.equal(seen.linkCalls.length, 0);
});

test('a failing backfill never stops the proposal going up for a vote', async () => {
  const row = sessionRow();
  const { seen } = await promoteWith({
    row,
    onUpdateLinkedIssues: () => { throw new Error('GitHub is down'); },
  });
  assert.equal(seen.linkCalls.length, 1, 'it was attempted');
  assert.equal(seen.seededWrites.length, 0, 'and not marked seeded, so it retries next time');
  assert.ok(seen.prCreated, 'the promote carried on regardless');
});
