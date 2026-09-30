// Tests for the app-provided state snapshot on POST /api/feedback (#685):
// the buildPageStateEmbed body suffix, the pageState validation, and the
// target gating (appended for app-targeted feedback, silently ignored
// for platform feedback).
//
// Same harness shape as tests/feedback-custom-title.test.js /
// tests/issue-screenshots.test.js: override getPool BEFORE requiring the
// route module, stub the GitHub calls, and hit the router over HTTP.
//
// Run with: node --test tests/feedback-page-state.test.js

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
// App-targeted feedback files through the GitHub App installation path.
let appCreates = [];
github.createIssue = async (owner, repo, { title, body }) => {
  appCreates.push({ owner, repo, title, body });
  return { number: 9, html_url: `https://github.com/${owner}/${repo}/issues/9` };
};

// Platform-target feedback files via a raw fetch to api.github.com with
// the PAT — stub it and capture the POSTed body. Local requests to the
// test server pass through to the real fetch.
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
  buildPageStateEmbed,
  MAX_PAGE_STATE_CHARS,
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
  poolQueries = [];
  ghCreates = [];
  appCreates = [];
  poolHandler = async (sql) => {
    // App lookup for app-targeted feedback.
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

// ── Pure embed helper ────────────────────────────────────────────────

test('buildPageStateEmbed: collapsed details block with a four-backtick fence', () => {
  assert.equal(
    buildPageStateEmbed('{"view":"board"}', false),
    '\n\n<details>\n<summary>App state snapshot (provided by the app)</summary>\n\n````json\n{"view":"board"}\n````\n</details>'
  );
});

test('buildPageStateEmbed: truncated variant labels the summary', () => {
  const embed = buildPageStateEmbed('{"partial', true);
  assert.match(embed, /<summary>App state snapshot \(provided by the app, truncated\)<\/summary>/);
  assert.match(embed, /````json\n\{"partial\n````/);
});

test('buildPageStateEmbed: state containing ``` stays inside the fence', () => {
  const embed = buildPageStateEmbed('{"md":"```js\\nhi\\n```"}', false);
  // The outer fence is four backticks, so the embedded triple-backtick
  // sequence cannot close the block.
  assert.match(embed, /````json\n.*```.*\n````/s);
});

// ── Route behaviour ──────────────────────────────────────────────────

test('app-targeted feedback appends the state snapshot after the description', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Board is broken',
      target: 'app',
      appSlug: 'demo-app',
      pageState: '{"view":"board","count":3}',
    });
    assert.equal(res.status, 200);
    assert.equal(appCreates.length, 1);
    const { body } = appCreates[0];
    assert.match(body, /Board is broken/);
    assert.match(body, /<details>\n<summary>App state snapshot \(provided by the app\)<\/summary>/);
    assert.match(body, /````json\n\{"view":"board","count":3\}\n````/);
    assert.ok(body.indexOf('Board is broken') < body.indexOf('<details>'), 'snapshot goes after the description');
  } finally {
    server.close();
  }
});

test('pageStateTruncated labels the summary line', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Broken',
      target: 'app',
      appSlug: 'demo-app',
      pageState: '{"cut',
      pageStateTruncated: true,
    });
    assert.equal(res.status, 200);
    assert.match(appCreates[0].body, /App state snapshot \(provided by the app, truncated\)/);
  } finally {
    server.close();
  }
});

test('platform-targeted feedback silently ignores pageState', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Platform gripe',
      target: 'platform',
      pageState: '{"should":"not appear"}',
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    assert.ok(!ghCreates[0].body.includes('App state snapshot'), 'no snapshot block');
    assert.ok(!ghCreates[0].body.includes('should'), 'no snapshot content');
  } finally {
    server.close();
  }
});

test('app-targeted feedback without pageState files exactly as before', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, { description: 'Plain report', target: 'app', appSlug: 'demo-app' });
    assert.equal(res.status, 200);
    assert.ok(!appCreates[0].body.includes('<details>'), 'no snapshot block when none was sent');
  } finally {
    server.close();
  }
});

test('over-cap pageState is rejected with 400 (nothing filed)', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Broken',
      target: 'app',
      appSlug: 'demo-app',
      pageState: 'x'.repeat(MAX_PAGE_STATE_CHARS + 1),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /too large/i);
    assert.equal(appCreates.length, 0);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('non-string pageState is rejected with 400 (nothing filed)', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, {
      description: 'Broken',
      target: 'app',
      appSlug: 'demo-app',
      pageState: { not: 'a string' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /must be a string/i);
    assert.equal(appCreates.length, 0);
  } finally {
    server.close();
  }
});
