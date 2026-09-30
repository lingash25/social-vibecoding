// Per-app notification preferences answer only for apps the caller can see.
//
// GET / PATCH / DELETE /api/apps/:slug/notification-preferences resolve the
// app through the same view-access check as every other /api/apps/:slug
// route (appAccess.checkAppAccess). An app the caller may not view answers
// exactly as a missing one does, so its name and id are never disclosed.
// The one exception is the reset: a caller who already holds preference
// rows for an app they have since lost access to may still clear them.
//
// Run with: node --test tests/notification-preferences-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');

const APPS = {
  'public-app': {
    id: 11, slug: 'public-app', name: 'Public App', created_by: 1, self_hosted: false,
    collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null,
    is_admin: false,
  },
  'private-app': {
    id: 12, slug: 'private-app', name: 'Secret Project', created_by: 1, self_hosted: false,
    collab_visibility: 'private', view_visibility: 'private', moderation_suspended_at: null,
    is_admin: false,
  },
  'suspended-app': {
    id: 13, slug: 'suspended-app', name: 'Suspended App', created_by: 1, self_hosted: false,
    collab_visibility: 'public', view_visibility: 'public',
    moderation_suspended_at: '2026-09-01T00:00:00Z', is_admin: false,
  },
};

// `ownRows` is the set of app ids the caller already holds preference rows for.
function makePool({ ownRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/FROM apps WHERE slug = \$1/.test(text)) {
        const app = APPS[params[0]];
        return Promise.resolve({ rows: app ? [{ ...app }] : [] });
      }
      if (/FROM user_app_blocks/.test(text)) return Promise.resolve({ rows: [] });
      if (/FROM app_collaborators/.test(text)) return Promise.resolve({ rows: [] });
      if (/SELECT 1 FROM notification_preferences/.test(text)) {
        return Promise.resolve({ rows: ownRows.includes(params[1]) ? [{ '?column?': 1 }] : [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

function loadRoutes(pool) {
  const prevGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const routePath = require.resolve('../src/routes/notifications');
  delete require.cache[routePath];
  const mod = require('../src/routes/notifications');
  poolMod.getPool = prevGetPool;
  delete require.cache[routePath];
  return mod;
}

async function withServer(pool, fn) {
  const mod = loadRoutes(pool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(mod.notificationsRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/apps`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const deleted = (pool) => pool.calls.filter((c) => /^DELETE FROM notification_preferences/.test(c.sql.trim()));
const written = (pool) => pool.calls.filter((c) => /INSERT INTO notification_preferences/.test(c.sql));

test('a visible app answers GET and PATCH with its preferences', async () => {
  const pool = makePool();
  await withServer(pool, async (base) => {
    const got = await call(`${base}/public-app/notification-preferences`, 'GET');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.app, { id: 11, slug: 'public-app', name: 'Public App' });

    const patched = await call(`${base}/public-app/notification-preferences`, 'PATCH', { preferences: { new_issues: true } });
    assert.equal(patched.status, 200);
    assert.equal(written(pool).length, 1);
  });
});

test('a private app the caller cannot view is not found on GET and PATCH', async () => {
  const pool = makePool();
  await withServer(pool, async (base) => {
    const missing = await call(`${base}/no-such-app/notification-preferences`, 'GET');
    const got = await call(`${base}/private-app/notification-preferences`, 'GET');
    assert.equal(got.status, 404);
    assert.deepEqual(got.body, missing.body, 'a hidden app answers exactly as a missing one');
    assert.doesNotMatch(JSON.stringify(got.body), /Secret Project|12/);

    const patched = await call(`${base}/private-app/notification-preferences`, 'PATCH', { preferences: { new_issues: true } });
    assert.equal(patched.status, 404);
    assert.deepEqual(patched.body, missing.body);
    assert.equal(written(pool).length, 0, 'nothing is stored for a hidden app');
  });
});

test('a suspended app is not found either', async () => {
  const pool = makePool();
  await withServer(pool, async (base) => {
    const got = await call(`${base}/suspended-app/notification-preferences`, 'GET');
    assert.equal(got.status, 404);
  });
});

test('DELETE clears the caller\'s own rows for an app they can no longer see', async () => {
  const pool = makePool({ ownRows: [12] });
  await withServer(pool, async (base) => {
    const res = await call(`${base}/private-app/notification-preferences`, 'DELETE');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    const [del] = deleted(pool);
    assert.ok(del, 'the rows are deleted');
    assert.deepEqual(del.params, [7, 12]);
  });
});

test('DELETE with no rows on a hidden app answers as for a missing app', async () => {
  const pool = makePool();
  await withServer(pool, async (base) => {
    const missing = await call(`${base}/no-such-app/notification-preferences`, 'DELETE');
    const hidden = await call(`${base}/private-app/notification-preferences`, 'DELETE');
    assert.equal(missing.status, 404);
    assert.equal(hidden.status, missing.status);
    assert.deepEqual(hidden.body, missing.body);
    assert.equal(deleted(pool).length, 0);
  });
});

test('DELETE on a visible app works without any existing rows', async () => {
  const pool = makePool();
  await withServer(pool, async (base) => {
    const res = await call(`${base}/public-app/notification-preferences`, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal(deleted(pool).length, 1);
  });
});
