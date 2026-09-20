// #767: the platform's own graceful shutdown.
//
// cleanup() already drained in-flight worker handlers, but it never closed
// the HTTP listener and never closed the pg pool — so for the whole 5s
// drain the process kept ACCEPTING new requests, then exited from under
// them and severed any in-flight query at process.exit(0).
//
// Closing the listener first is safe (and better) specifically because
// Caddy's apex proxy and wildcard forward_auth gate both hold-and-retry a
// refused dial for 30s: a connection refused during the drain is re-dialled
// into the new container rather than 502'd.
//
// Everything here is modelled — stubbed listener, stubbed pool, stubbed
// process.exit — so the ordering assertions never depend on wall clock.
//
// Run with: node --test tests/server-graceful-shutdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// loadConfig() (module level in server.js) hard-exits when these are
// missing — provide dummies before the require below. Same preamble as
// tests/recovery-headless-guard.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// Capture log lines by swapping the logger's sinks in place — server.js's
// require graph binds `log` deep in the route tree, so replacing the module
// wholesale isn't reliable this late.
const log = require('../src/services/logger');
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  log[level] = (cat, msg, data) => { logs.push({ level, cat, msg, data }); };
}

// Module-level code in server.js's require graph schedules housekeeping
// timers without unref — harmless in production, but they'd keep this test
// process alive forever. Auto-unref anything scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let serverModule;
try {
  serverModule = require('../server');
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

// One shared module instance; each test resets the shutdown targets (which
// also clears the cleanupStarted latch) via __setShutdownTargets.
function loadServer() {
  logs.length = 0;
  return { server: serverModule, logs, restore: () => {} };
}

// A stand-in for the node http.Server, recording which teardown calls the
// shutdown path makes.
function fakeListener() {
  const events = [];
  return {
    events,
    close(cb) { events.push('close'); if (cb) cb(); },
    closeIdleConnections() { events.push('closeIdle'); },
    closeAllConnections() { events.push('closeAll'); },
  };
}

function fakePool({ endImpl } = {}) {
  const events = [];
  return {
    events,
    end: endImpl || (async () => { events.push('end'); }),
  };
}

async function runCleanup(server, { listener, pool }) {
  const order = [];
  const realExit = process.exit;
  process.exit = (code) => { order.push(`exit:${code}`); };
  server.__setShutdownTargets({ server: listener, pool });
  try {
    await server.cleanup();
  } finally {
    process.exit = realExit;
  }
  return order;
}

test('cleanup closes the listener, then the pool, then exits', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    const seq = [];
    const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });

    const order = await runCleanup(server, { listener, pool });

    assert.ok(listener.events.includes('close'), 'the listener must stop accepting');
    assert.ok(listener.events.includes('closeIdle'), 'idle keep-alives are dropped at once');
    assert.equal(listener.events[0], 'close');
    assert.deepEqual(seq, ['poolEnd'], 'the pool must be closed before exit');
    assert.deepEqual(order, ['exit:0']);
  } finally {
    restore();
  }
});

test('the listener is closed BEFORE the pool — new work must not arrive mid-drain', async () => {
  const { server, restore } = loadServer();
  try {
    const seq = [];
    const listener = {
      close(cb) { seq.push('listenerClose'); if (cb) cb(); },
      closeIdleConnections() {},
      closeAllConnections() {},
    };
    const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });

    await runCleanup(server, { listener, pool });

    assert.deepEqual(seq, ['listenerClose', 'poolEnd']);
  } finally {
    restore();
  }
});

test('a hanging pool.end() still reaches exit inside the bounded budget', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    // A pool that never settles: the race against POOL_CLOSE_TIMEOUT_MS is
    // what stops it holding the process past the SIGKILL deadline.
    const pool = fakePool({ endImpl: () => new Promise(() => {}) });

    const startedAt = Date.now();
    const order = await runCleanup(server, { listener, pool });
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(order, ['exit:0'], 'a stuck pool must not prevent exit');
    assert.ok(elapsed < server.POOL_CLOSE_TIMEOUT_MS + 2000,
      `cleanup took ${elapsed}ms; the pool close must be bounded`);
  } finally {
    restore();
  }
});

test('a rejecting pool.end() is logged and does not block exit', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const listener = fakeListener();
    const pool = fakePool({ endImpl: async () => { throw new Error('pool is on fire'); } });

    const order = await runCleanup(server, { listener, pool });

    assert.deepEqual(order, ['exit:0']);
    assert.ok(logs.some((l) => l.msg === 'Pool close failed' && /on fire/.test(l.data.err)));
  } finally {
    restore();
  }
});

test('cleanup is idempotent — SIGTERM then SIGINT must not tear down twice', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    let ends = 0;
    const pool = fakePool({ endImpl: async () => { ends += 1; } });

    const realExit = process.exit;
    const exits = [];
    process.exit = (code) => { exits.push(code); };
    server.__setShutdownTargets({ server: listener, pool });
    try {
      await Promise.all([server.cleanup(), server.cleanup()]);
      await server.cleanup();
    } finally {
      process.exit = realExit;
    }

    assert.equal(ends, 1, 'the pool must be closed exactly once');
    assert.equal(listener.events.filter((e) => e === 'close').length, 1);
    assert.equal(exits.length, 1);
  } finally {
    restore();
  }
});

test('cleanup survives a listener that throws on close', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const listener = { close() { throw new Error('already closed'); } };
    const pool = fakePool();

    const order = await runCleanup(server, { listener, pool });

    assert.deepEqual(order, ['exit:0']);
    assert.ok(logs.some((l) => l.msg === 'Listener close failed'));
  } finally {
    restore();
  }
});

test('cleanup works with no listener or pool registered (boot failed early)', async () => {
  const { server, restore } = loadServer();
  try {
    const order = await runCleanup(server, { listener: null, pool: null });
    assert.deepEqual(order, ['exit:0']);
  } finally {
    restore();
  }
});

test('SIGTERM and SIGINT are both wired to cleanup', () => {
  const { server, restore } = loadServer();
  try {
    assert.ok(process.listeners('SIGTERM').length > 0, 'SIGTERM must have a handler');
    assert.ok(process.listeners('SIGINT').length > 0, 'SIGINT must have a handler');
    assert.equal(typeof server.cleanup, 'function');
  } finally {
    restore();
  }
});

// ── #2545: the process being replaced tells its tabs where traffic went ──
//
// At SIGTERM during a rollout, the build this deployment is moving to is
// already on record (deploy-status reads it for the version row), and the
// listener has just closed — so nothing a tab fetches on hearing this can be
// answered by the build being retired. cleanup() reads the target and, if it
// is another build, pushes `platform_version` to every open events socket.
// Modelled through the same seam as the rest of this file: deploy-status
// and ws are the shared module instances server.js holds, stubbed in place.

const deployStatus = require('../src/services/deploy-status');
const wsService = require('../src/services/ws');
const OWN = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

/** `gitSha: null` runs with GIT_SHA unset. */
function withRollout({ gitSha = OWN, read } = {}, run) {
  const savedSha = process.env.GIT_SHA;
  const savedRead = deployStatus.read;
  const savedPush = wsService.pushPlatformVersion;
  const pushes = [];
  if (gitSha === null) delete process.env.GIT_SHA;
  else process.env.GIT_SHA = gitSha;
  deployStatus.read = read;
  wsService.pushPlatformVersion = (payload) => { pushes.push(payload); return 2; };
  return Promise.resolve()
    .then(() => run(pushes))
    .finally(() => {
      if (savedSha === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = savedSha;
      deployStatus.read = savedRead;
      wsService.pushPlatformVersion = savedPush;
    });
}

test('a rollout SIGTERM announces the successor build to open sockets, after the listener closes', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const seq = [];
    const listener = {
      close(cb) { seq.push('listenerClose'); if (cb) cb(); },
      closeIdleConnections() {},
      closeAllConnections() {},
    };
    await withRollout({ read: async () => ({ deploying: true, sha: NEXT }) }, async (pushes) => {
      wsService.pushPlatformVersion = (payload) => { seq.push('push'); pushes.push(payload); return 2; };
      const order = await runCleanup(server, { listener, pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, [{ sha: NEXT, reason: 'rollout' }],
        'the tabs are told the build their requests land on now');
      assert.deepEqual(seq, ['listenerClose', 'push'],
        'told only once nothing they fetch next can reach this process');
      assert.ok(logs.some((l) => l.msg === 'Announced successor build to open sockets'
        && l.data.sha === NEXT && l.data.sockets === 2));
    });
  } finally {
    restore();
  }
});

test('a SIGTERM that is not a rollout says nothing', async () => {
  // Node drain, eviction, crash restart: the deployment still targets the
  // build this process is. Announcing it would only make every tab re-ask
  // for a build it already has.
  const { server, restore } = loadServer();
  try {
    await withRollout({ read: async () => ({ deploying: false, sha: OWN }) }, async (pushes) => {
      await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(pushes, []);
    });
  } finally {
    restore();
  }
});

test('a process with no build of its own does not look', async () => {
  // Local dev, and the staging previews: GIT_SHA unset or `dev`. There is
  // no successor to name, and nothing must be read on the way out.
  const { server, restore } = loadServer();
  try {
    for (const gitSha of [null, 'dev']) {
      let reads = 0;
      await withRollout({ gitSha, read: async () => { reads += 1; return { sha: NEXT }; } }, async (pushes) => {
        await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
        assert.deepEqual(pushes, []);
        assert.equal(reads, 0);
      });
    }
  } finally {
    restore();
  }
});

test('a target that cannot be read — unreachable, hung or failed — costs nothing but a log line', async () => {
  const { server, logs, restore } = loadServer();
  try {
    // No answer: the docker path with no marker, or a staging preview.
    await withRollout({ read: async () => null }, async (pushes) => {
      await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(pushes, []);
    });
    // A rejection.
    await withRollout({ read: async () => { throw new Error('apiserver away'); } }, async (pushes) => {
      const order = await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, []);
      assert.ok(logs.some((l) => l.msg === 'Successor build announcement failed' && /apiserver away/.test(l.data.err)));
    });
    // A read that never settles is raced against SUCCESSOR_ANNOUNCE_TIMEOUT_MS,
    // which sits inside the drain window: the announcement is awaited
    // alongside the drain, so it can never push exit past the budget the
    // grace test pins.
    assert.ok(server.SUCCESSOR_ANNOUNCE_TIMEOUT_MS <= server.DRAIN_TIMEOUT_MS);
    await withRollout({ read: () => new Promise(() => {}) }, async (pushes) => {
      const startedAt = Date.now();
      const order = await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, []);
      assert.ok(Date.now() - startedAt < server.DRAIN_TIMEOUT_MS,
        'a hung read is abandoned inside the drain window, not waited on');
    });
  } finally {
    restore();
  }
});
