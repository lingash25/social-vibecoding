// The "Saved offline" stamp on POST /api/feedback (#1054).
//
// A message the client outbox held for a while must not read on GitHub as if
// it were written the second it arrived — a maintainer needs to know the bug
// was seen hours ago, possibly against a screen that has since changed. The
// client sends `queuedAt`; the server prints one header line for it.
//
// The field is client-asserted, so the contract under test is deliberately
// forgiving: an implausible value prints nothing and the issue is still
// filed. Refusing the request would lose exactly the feedback the offline
// queue exists to save.
//
// Same harness shape as tests/feedback-page-state.test.js: override getPool
// BEFORE requiring the route module, stub the GitHub calls, hit the router
// over HTTP.
//
// Run with: node --test tests/feedback-queued-at.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: async (sql, params) => poolHandler(String(sql), params),
});

const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};
let appCreates = [];
github.createIssue = async (owner, repo, { title, body }) => {
  appCreates.push({ owner, repo, title, body });
  return { number: 9, html_url: `https://github.com/${owner}/${repo}/issues/9` };
};

process.env.GITHUB_BOT_TOKEN = 'test-pat';
let ghCreates = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    ghCreates.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: 'https://github.com/plat/repo/issues/42' }),
    };
  }
  return realFetch(url, opts);
};

const {
  feedbackRoutes,
  normalizeQueuedAt,
  MAX_QUEUED_AT_CHARS,
} = require('../src/routes/feedback');
const express = require('express');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  ghCreates = [];
  appCreates = [];
  poolHandler = async (sql) => {
    if (/SELECT name, repo_url, .* FROM apps WHERE slug/.test(sql)) {
      return {
        rows: [{ id: 3, slug: 'demo-app', name: 'Demo App', repo_url: 'https://github.com/owner/demo-app',
          view_visibility: 'public', collab_visibility: 'public' }],
      };
    }
    return { rows: [] };
  };
}

async function post(server, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

// ── Pure validation ──────────────────────────────────────────────────

test('normalizeQueuedAt: a plausible past timestamp normalises to ISO UTC', () => {
  assert.equal(normalizeQueuedAt('2026-08-11T09:30:00.000Z', NOW), '2026-08-11T09:30:00.000Z');
  // Any parseable form is accepted and normalised — the client controls the
  // string, the body line should not.
  assert.equal(normalizeQueuedAt('2026-08-11T11:00:00+01:00', NOW), '2026-08-11T10:00:00.000Z');
});

test('normalizeQueuedAt: garbage, oversize and unparseable values print nothing', () => {
  assert.equal(normalizeQueuedAt(undefined, NOW), null);
  assert.equal(normalizeQueuedAt(null, NOW), null);
  assert.equal(normalizeQueuedAt('', NOW), null);
  assert.equal(normalizeQueuedAt('yesterday', NOW), null);
  assert.equal(normalizeQueuedAt(NOW, NOW), null, 'a number is not the wire format');
  assert.equal(normalizeQueuedAt({}, NOW), null);
  assert.equal(normalizeQueuedAt('2026-08-11T09:30:00.000Z'.padEnd(MAX_QUEUED_AT_CHARS + 1, ' '), NOW), null);
});

test('normalizeQueuedAt: a future stamp is ignored rather than trusted', () => {
  assert.equal(normalizeQueuedAt(new Date(NOW + 3600_000).toISOString(), NOW), null);
});

test('normalizeQueuedAt: a live submit prints nothing — the issue timestamp already says it', () => {
  assert.equal(normalizeQueuedAt(new Date(NOW - 1000).toISOString(), NOW), null);
  assert.equal(normalizeQueuedAt(new Date(NOW - 59_000).toISOString(), NOW), null);
  assert.ok(normalizeQueuedAt(new Date(NOW - 61_000).toISOString(), NOW), 'a minute old does print');
});

test('normalizeQueuedAt: a stamp older than 90 days is a broken clock, not history', () => {
  assert.ok(normalizeQueuedAt(new Date(NOW - 89 * 86_400_000).toISOString(), NOW));
  assert.equal(normalizeQueuedAt(new Date(NOW - 91 * 86_400_000).toISOString(), NOW), null);
  assert.equal(normalizeQueuedAt('1970-01-01T00:00:00.000Z', NOW), null);
});

// ── Route behaviour ──────────────────────────────────────────────────

test('app-targeted feedback carries the Saved offline line above the description', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Board is broken',
      target: 'app',
      appSlug: 'demo-app',
      queuedAt: hoursAgo(3),
    });
    assert.equal(res.status, 200);
    const { body } = appCreates[0];
    assert.match(body, /\*\*Saved offline:\*\* \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ/);
    assert.ok(
      body.indexOf('**Saved offline:**') < body.indexOf('Board is broken'),
      'it is header context for the report, not part of it',
    );
    assert.ok(
      body.indexOf('**App:**') < body.indexOf('**Saved offline:**'),
      'it sits with the other header lines',
    );
  } finally {
    server.close();
  }
});

test('platform-targeted feedback carries it too', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'Header is wrong', queuedAt: hoursAgo(26) });
    assert.equal(res.status, 200);
    assert.match(ghCreates[0].body, /\*\*Source:\*\* .*\n\*\*Saved offline:\*\* /);
    assert.ok(ghCreates[0].body.indexOf('**Saved offline:**') < ghCreates[0].body.indexOf('Header is wrong'));
  } finally {
    server.close();
  }
});

test('a live submit files exactly the body it filed before this change', async () => {
  reset();
  const server = await startServer();
  try {
    await post(server, { description: 'Filed right now' });
    // No queuedAt at all: no line, and no stray blank line where it would go.
    assert.equal(ghCreates[0].body, '**Source:** Homeroom user (tester)\n\nFiled right now');

    await post(server, { description: 'Also right now', queuedAt: new Date().toISOString() });
    assert.equal(ghCreates[1].body, '**Source:** Homeroom user (tester)\n\nAlso right now');
  } finally {
    server.close();
  }
});

test('an unusable queuedAt never costs the user their feedback', async () => {
  reset();
  const server = await startServer();
  try {
    for (const queuedAt of ['not a date', 12345, { at: 'now' }, '2999-01-01T00:00:00.000Z', '1970-01-01T00:00:00Z']) {
      const res = await post(server, { description: `bad stamp ${JSON.stringify(queuedAt)}`, queuedAt });
      assert.equal(res.status, 200, `queuedAt ${JSON.stringify(queuedAt)} must not fail the request`);
    }
    assert.equal(ghCreates.length, 5, 'every one still filed');
    for (const created of ghCreates) {
      assert.doesNotMatch(created.body, /Saved offline/, 'and none of them printed a bogus stamp');
    }
  } finally {
    server.close();
  }
});
