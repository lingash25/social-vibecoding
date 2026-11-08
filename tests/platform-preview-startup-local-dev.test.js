// A local development stack (USERNODE_LOCAL_DEV=1, docker-compose.dev.yml or a
// native `node server.js` against the dev database) has no preview cluster
// whose retirement a conductor could prove, so a web-only process there must
// not wait 180 s for that proof and exit. The barrier is skipped for local
// development the way it is for staging, and only there: production and
// previews never set USERNODE_LOCAL_DEV.
//
// Run with: node --test tests/platform-preview-startup-local-dev.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const startup = require('../src/services/platform-preview-startup');

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const refusingPool = { query() { throw new Error('the database must not be asked'); } };

test('a web process on a local development stack skips the preview-retirement barrier', async () => {
  await withEnv({ USERNODE_LOCAL_DEV: '1', USERNODE_ENV: undefined, PROCESS_ROLE: 'web' }, async () => {
    const result = await startup.beforeServe({}, refusingPool, { timeoutMs: 50, pollMs: 5 });
    assert.deepEqual(result, { skipped: 'local-dev' });
  });
});

test('without the local-development flag the web barrier still asks the database and fails closed', async () => {
  await withEnv({ USERNODE_LOCAL_DEV: undefined, USERNODE_ENV: undefined, PROCESS_ROLE: 'web' }, async () => {
    let asked = 0;
    const pool = { async query() { asked += 1; return { rows: [] }; } };
    await assert.rejects(startup.beforeServe({ edgeJwtSecret: 'test-only-edge-secret-of-enough-length' }, pool, { timeoutMs: 20, pollMs: 5 }), /preview retirement/);
    assert.ok(asked > 0, 'the barrier read the conductor\'s proof');
  });
});
