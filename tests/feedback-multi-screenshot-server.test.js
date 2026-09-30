// #3027: Send feedback takes more than one image ("one before saving and one
// after saving"). Server half: POST /api/feedback accepts `screenshotIds`, an
// array of already-uploaded ids, up to MAX_SCREENSHOTS_PER_ISSUE. Every id is
// checked the same way the single `screenshotId` always was — 32-hex, owned by
// this user, not yet linked — the count is the server's own (never a number
// the client asserts), and the filed issue body embeds every image in order.
// A legacy single `screenshotId` (what an outbox entry queued before this
// change still carries) keeps working and counts toward the same limit.
//
// Per-file upload validation is untouched (tests/issue-screenshots.test.js):
// every image is its own POST /api/feedback/screenshot, sniffed and capped at
// 4 MB on its own. One test below re-runs that across a sequence of uploads so
// the multi-image flow cannot smuggle a bad file in beside good ones.
//
// Same harness shape as tests/issue-screenshots.test.js.
//
// Run with: node --test tests/feedback-multi-screenshot-server.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueries = [];
let poolHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: async (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return poolHandler(String(sql), params);
  },
});

const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

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
  buildScreenshotEmbed,
  buildScreenshotsEmbed,
  parseScreenshotIds,
  MAX_SCREENSHOTS_PER_ISSUE,
  MAX_SCREENSHOT_BYTES,
} = require('../src/routes/feedback');
const { USERNODE_DOMAIN } = require('../src/services/caddy');
const express = require('express');

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(express.json());
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueries = [];
  ghCreates = [];
  poolHandler = async () => ({ rows: [] });
}

// The ownership lookup: answers with exactly the rows this user owns and has
// not linked yet, so a test can make any subset of ids "foreign".
function ownerLookup(owned) {
  return async (sql, params) => {
    if (sql.includes('FROM issue_screenshots')) {
      const asked = Array.isArray(params[0]) ? params[0] : [params[0]];
      return { rows: asked.filter((id) => owned.includes(id)).map((id) => ({ id })) };
    }
    return { rows: [] };
  };
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);
const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const C = 'c3'.repeat(16);
const D = 'd4'.repeat(16);

async function postFeedback(server, body) {
  return realFetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────

test('the per-issue image limit is three', () => {
  assert.equal(MAX_SCREENSHOTS_PER_ISSUE, 3);
});

test('parseScreenshotIds: absent, legacy single, and array forms', () => {
  assert.deepEqual(parseScreenshotIds({}), { ok: true, ids: [] });
  assert.deepEqual(parseScreenshotIds({ screenshotId: '', screenshotIds: [] }), { ok: true, ids: [] });
  assert.deepEqual(parseScreenshotIds({ screenshotId: A }), { ok: true, ids: [A] });
  assert.deepEqual(parseScreenshotIds({ screenshotIds: [A, B, C] }), { ok: true, ids: [A, B, C] });
  // A legacy id beside the array joins it (an outbox entry can carry both),
  // and the same id twice is one image, not two.
  assert.deepEqual(parseScreenshotIds({ screenshotIds: [A, B], screenshotId: C }), { ok: true, ids: [A, B, C] });
  assert.deepEqual(parseScreenshotIds({ screenshotIds: [A], screenshotId: A }), { ok: true, ids: [A] });
});

test('parseScreenshotIds: the limit is counted by the server, before dedupe', () => {
  assert.equal(parseScreenshotIds({ screenshotIds: [A, B, C, D] }).ok, false);
  // Padding with duplicates cannot hide an over-long array…
  assert.equal(parseScreenshotIds({ screenshotIds: [A, A, A, A] }).ok, false);
  // …and a legacy id cannot push a full array past the limit.
  assert.equal(parseScreenshotIds({ screenshotIds: [A, B, C], screenshotId: D }).ok, false);
  // A huge array is refused without looking at its contents.
  assert.equal(parseScreenshotIds({ screenshotIds: new Array(10000).fill(A) }).ok, false);
});

test('parseScreenshotIds: every id must be a 32-hex string', () => {
  assert.equal(parseScreenshotIds({ screenshotIds: A }).ok, false, 'not an array');
  assert.equal(parseScreenshotIds({ screenshotIds: { 0: A, length: 1 } }).ok, false, 'array-like is not an array');
  assert.equal(parseScreenshotIds({ screenshotIds: [A, 'nope'] }).ok, false);
  assert.equal(parseScreenshotIds({ screenshotIds: [A, 7] }).ok, false);
  assert.equal(parseScreenshotIds({ screenshotIds: [A, null] }).ok, false);
  assert.equal(parseScreenshotIds({ screenshotIds: [A.toUpperCase()] }).ok, false);
  assert.equal(parseScreenshotIds({ screenshotId: 'not-a-hex-id' }).ok, false);
  assert.equal(parseScreenshotIds({ screenshotId: 12 }).ok, false);
});

test('buildScreenshotsEmbed: one image is byte-identical to the old single embed', () => {
  assert.equal(buildScreenshotsEmbed([], 'example.org'), '');
  assert.equal(buildScreenshotsEmbed([A], 'example.org'), buildScreenshotEmbed(A, 'example.org'));
});

test('buildScreenshotsEmbed: several images are numbered, in order', () => {
  assert.equal(
    buildScreenshotsEmbed([A, B, C], 'example.org'),
    '\n\n**Screenshots:**\n'
      + `![Screenshot 1](https://example.org/issue-images/${A})\n`
      + `![Screenshot 2](https://example.org/issue-images/${B})\n`
      + `![Screenshot 3](https://example.org/issue-images/${C})`,
  );
});

// ── POST /api/feedback ───────────────────────────────────────────────

test('three owned images are all embedded and all linked to the filed issue', async () => {
  reset();
  poolHandler = ownerLookup([A, B, C]);
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Before and after saving', title: 'Tier list', screenshotIds: [A, B, C],
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    const body = ghCreates[0].body;
    assert.ok(body.endsWith(buildScreenshotsEmbed([A, B, C], USERNODE_DOMAIN)),
      `issue body should embed every image, got: ${body}`);
    for (const id of [A, B, C]) {
      assert.ok(body.includes(`/issue-images/${id}`), `${id} is embedded`);
    }

    const lookup = poolQueries.find((q) => /SELECT[\s\S]*FROM issue_screenshots/.test(q.sql));
    assert.ok(lookup, 'the ids are checked before anything is filed');
    assert.deepEqual(lookup.params, [[A, B, C], 7], 'ownership is checked against the signed-in user');
    assert.match(lookup.sql, /user_id = \$2/);
    assert.match(lookup.sql, /issue_number IS NULL/);

    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_screenshots'));
    assert.ok(link, 'the rows are linked to the filed issue');
    assert.deepEqual(link.params, [[A, B, C], 'plat', 'repo', 42, 7]);
    // Linking stays bound to the uploader and to rows nobody linked yet.
    assert.match(link.sql, /user_id = \$5/);
    assert.match(link.sql, /issue_number IS NULL/);
  } finally {
    server.close();
  }
});

test('a fourth image is refused before any lookup, and nothing is filed', async () => {
  reset();
  poolHandler = ownerLookup([A, B, C, D]);
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Too many', title: 'T', screenshotIds: [A, B, C, D],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at most 3/i);
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_screenshots')), false);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('one foreign or already-used id fails the whole submit', async () => {
  reset();
  poolHandler = ownerLookup([A, C]); // B belongs to somebody else, or is linked
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Mixed', title: 'T', screenshotIds: [A, B, C],
    });
    assert.equal(res.status, 400);
    assert.equal(ghCreates.length, 0);
    assert.equal(poolQueries.some((q) => q.sql.includes('UPDATE issue_screenshots')), false);
  } finally {
    server.close();
  }
});

test('a malformed id in the array is a 400 without any lookup', async () => {
  reset();
  const server = await startServer();
  try {
    for (const screenshotIds of [[A, 'nope'], 'a-string', [A, { id: B }]]) {
      const res = await postFeedback(server, { description: 'Bad', title: 'T', screenshotIds });
      assert.equal(res.status, 400, JSON.stringify(screenshotIds));
    }
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_screenshots')), false);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('a legacy single screenshotId still files with the old embed line', async () => {
  reset();
  poolHandler = ownerLookup([A]);
  const server = await startServer();
  try {
    const res = await postFeedback(server, { description: 'Old outbox entry', title: 'T', screenshotId: A });
    assert.equal(res.status, 200);
    assert.ok(ghCreates[0].body.endsWith(buildScreenshotEmbed(A, USERNODE_DOMAIN)));
    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_screenshots'));
    assert.deepEqual(link.params, [[A], 'plat', 'repo', 42, 7]);
  } finally {
    server.close();
  }
});

test('app-targeted feedback embeds every image too', async () => {
  reset();
  const owned = ownerLookup([A, B]);
  poolHandler = async (sql, params) => {
    if (sql.includes('FROM apps')) {
      return { rows: [{ id: 3, slug: 'tiers', name: 'Tier list', repo_url: 'https://github.com/acme/tiers',
        view_visibility: 'public', collab_visibility: 'public' }] };
    }
    return owned(sql, params);
  };
  let created = null;
  const realCreate = github.createIssue;
  github.createIssue = async (owner, repo, issue) => {
    created = { owner, repo, ...issue };
    return { number: 9, html_url: 'https://github.com/acme/tiers/issues/9' };
  };
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Before and after', title: 'T', target: 'app', appSlug: 'tiers', screenshotIds: [A, B],
    });
    assert.equal(res.status, 200);
    assert.ok(created, 'filed into the app repo');
    assert.ok(created.body.includes(buildScreenshotsEmbed([A, B], USERNODE_DOMAIN)));
    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_screenshots'));
    assert.deepEqual(link.params, [[A, B], 'acme', 'tiers', 9, 7]);
  } finally {
    github.createIssue = realCreate;
    server.close();
  }
});

// ── Uploads: every image is validated on its own ─────────────────────

test('each upload in a multi-image sequence is sniffed and capped on its own', async () => {
  reset();
  const server = await startServer();
  const upload = (body) => realFetch(`http://127.0.0.1:${server.address().port}/api/feedback/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  const big = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1);
  PNG.copy(big, 0);
  try {
    assert.equal((await upload(PNG)).status, 200);
    assert.equal((await upload(GIF)).status, 400, 'a GIF beside good images is still refused');
    assert.equal((await upload(big)).status, 400, 'an over-cap image beside good ones is still refused');
    assert.equal((await upload(JPEG)).status, 200);
    const inserts = poolQueries.filter((q) => q.sql.includes('INSERT INTO issue_screenshots'));
    assert.equal(inserts.length, 2, 'only the two valid images are stored');
    assert.deepEqual(inserts.map((q) => q.params[2]), ['image/png', 'image/jpeg']);
    assert.ok(inserts.every((q) => q.params[1] === 7), 'every row is bound to the uploader');
  } finally {
    server.close();
  }
});
