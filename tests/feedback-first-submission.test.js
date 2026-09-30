const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const app = {
  id: 3, slug: 'demo-app', name: 'Demo', repo_url: 'https://github.com/owner/demo',
  created_by: 1, self_hosted: false, view_visibility: 'public', collab_visibility: 'public',
};
const platform = { ...app, id: 1, slug: 'platform-app', repo_url: 'https://github.com/platform/repo', self_hosted: true };
let user;
let seen;
let queries;
let issueNumber;
let githubFails;
let markerFails;
let destinationFails;
let platformRegistered;
let databaseClient;

require('../src/db/pool').getPool = () => ({
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/UPDATE users SET first_feedback_at/.test(sql)) {
      if (databaseClient) return databaseClient.query(sql, params);
      if (markerFails) throw new Error('database unavailable');
      assert.match(sql, /WHERE id = \$1 AND first_feedback_at IS NULL\s+RETURNING id/);
      if (seen.has(params[0])) return { rows: [] };
      seen.add(params[0]);
      return { rows: [{ id: params[0] }] };
    }
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      // The filing lookup selects repo_url; only the first-feedback
      // destination lookup (access columns alone) is made to fail.
      if (destinationFails && !/repo_url/.test(sql)) throw new Error('lookup unavailable');
      return { rows: params[0] === app.slug ? [app] : [] };
    }
    if (/FROM apps/.test(sql)) return { rows: platformRegistered ? [app, platform] : [app] };
    return { rows: [] };
  },
});
const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};
github.createIssue = async () => {
  if (githubFails) throw new Error('GitHub unavailable');
  return { number: ++issueNumber, html_url: `https://github.com/owner/demo/issues/${issueNumber}` };
};
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { pushIssueUpdate() {} } };
const oldToken = process.env.GITHUB_BOT_TOKEN;
process.env.GITHUB_BOT_TOKEN = 'test-token';
const realFetch = global.fetch;
global.fetch = async (url, opts) => String(url).startsWith('https://api.github.com/')
  ? { ok: !githubFails, status: githubFails ? 502 : 201, text: async () => '', json: async () => ({ number: ++issueNumber }) }
  : realFetch(url, opts);
const { feedbackRoutes } = require('../src/routes/feedback');
const { feedbackSubmitLimiter } = require('../src/middleware/rate-limits');
let server;
test.before(async () => {
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => { req.user = user; next(); });
  serverApp.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/platform/repo' }));
  server = await new Promise(resolve => {
    const listener = serverApp.listen(0, () => resolve(listener));
  });
});
test.after(() => {
  server.close();
  global.fetch = realFetch;
  if (oldToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
  else process.env.GITHUB_BOT_TOKEN = oldToken;
});
test.beforeEach(() => {
  // #2520: POST /api/feedback is limited to 10 submissions per hour per
  // user and this suite files more than that between its two reporters,
  // so each test starts from fresh buckets rather than inheriting the
  // last one's.
  feedbackSubmitLimiter.resetKey('user:7');
  feedbackSubmitLimiter.resetKey('user:8');
  user = { id: 7, username: 'reporter' };
  seen = new Set(); queries = []; issueNumber = 40;
  githubFails = markerFails = destinationFails = false;
  platformRegistered = true;
  app.view_visibility = app.collab_visibility = 'public';
  platform.view_visibility = platform.collab_visibility = 'public';
});
async function submit(overrides = {}) {
  const response = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'The board jumps when scrolling.', title: 'Board jumps', target: 'app', appSlug: app.slug, ...overrides }),
  });
  return { status: response.status, data: await response.json() };
}

test('the first successful feedback returns the filed issue and allowed next steps', async () => {
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.deepEqual(data.firstFeedback, { userId: 7, issueNumber: 41, appSlug: 'demo-app', canFix: true });
  assert.equal(seen.has(7), true);
});
test('the moment is account-wide across apps and not repeated on later submissions', async () => {
  assert.ok((await submit()).data.firstFeedback);
  assert.equal((await submit({ target: 'platform' })).data.firstFeedback, undefined);
  user = { id: 8, username: 'another-reporter' };
  assert.ok((await submit()).data.firstFeedback);
});
test('concurrent successful submissions only claim one first-feedback moment', async () => {
  const results = await Promise.all([submit(), submit()]);
  assert.equal(results.filter(r => r.data.firstFeedback).length, 1);
  assert.ok(results.every(r => r.status === 200));
});
test('platform feedback links the platform board even when another app is open', async () => {
  const { data } = await submit({ target: 'platform' });
  assert.equal(data.firstFeedback.appSlug, 'platform-app');
});
test('validation and GitHub failures do not consume the first-feedback moment', async () => {
  assert.equal((await submit({ description: '' })).status, 400);
  githubFails = true;
  assert.equal((await submit()).status, 502);
  assert.equal(seen.size, 0);
  githubFails = false;
  assert.ok((await submit()).data.firstFeedback);
});
test('marker failure never turns an already-filed issue into a failed submit', async () => {
  markerFails = true;
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.ok(data.url);
  assert.equal(data.firstFeedback, undefined);
});
test('read-only viewers get the board but cannot start a fix', async () => {
  app.collab_visibility = 'private';
  const { data } = await submit();
  assert.equal(data.firstFeedback.appSlug, app.slug);
  assert.equal(data.firstFeedback.canFix, false);
});
test('feedback on an app the reporter cannot view is not filed and keeps the moment', async () => {
  app.view_visibility = 'private';
  const { status, data } = await submit();
  assert.equal(status, 404);
  assert.deepEqual(data, { error: 'App not found' });
  assert.equal(issueNumber, 40);
  assert.equal(seen.size, 0);
});
test('unavailable or inaccessible destinations preserve the congratulations without unsafe links', async () => {
  platform.view_visibility = 'private';
  const { status, data } = await submit({ target: 'platform' });
  assert.equal(status, 200);
  assert.equal(data.firstFeedback.appSlug, null);
  assert.equal(data.firstFeedback.canFix, false);
});
test('a destination lookup failure still returns successful feedback', async () => {
  destinationFails = true;
  const { status, data } = await submit();
  assert.equal(status, 200);
  assert.equal(data.firstFeedback.appSlug, null);
});
test('an unregistered platform repo has no invented app destination', async () => {
  platformRegistered = false;
  const { data } = await submit({ target: 'platform' });
  assert.equal(data.firstFeedback.appSlug, null);
});
test('offline feedback earns the moment when it reaches the server', async () => {
  const { data } = await submit({ queuedAt: new Date(Date.now() - 120000).toISOString() });
  assert.ok(data.firstFeedback);
});

test('the database marker survives migration reruns and concurrent HTTP submissions', async t => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 1500,
  });
  try { await client.connect(); }
  catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    return t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database test.');
  }
  const namespace = `first_feedback_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace}, public`);
    await client.query('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (7), (8)');
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const migration = schema.match(/^ALTER TABLE users ADD COLUMN IF NOT EXISTS first_feedback_at .*;$/m)[0];
    await client.query(migration);
    databaseClient = client;
    const results = await Promise.all([submit(), submit()]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results.filter(result => result.data.firstFeedback).length, 1);
    const before = (await client.query('SELECT first_feedback_at FROM users WHERE id = 7')).rows[0];
    assert.ok(before.first_feedback_at);
    await client.query(migration);
    assert.equal((await submit()).data.firstFeedback, undefined);
    const after = (await client.query('SELECT first_feedback_at FROM users WHERE id = 7')).rows[0];
    assert.deepEqual(after, before, 'migration and later feedback must preserve the original timestamp');
    user = { id: 8, username: 'another-reporter' };
    assert.ok((await submit()).data.firstFeedback, 'another account still earns its own moment');
  } finally {
    databaseClient = null;
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA ${namespace} CASCADE`);
    await client.end();
  }
});
