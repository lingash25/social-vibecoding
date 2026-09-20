// #2545: the build the server is, told over /ws/events instead of polled for.
//
// Two messages, one shape — `{ type: 'platform_version', sha, reason }`:
//
//   * on every events handshake, the build the socket landed on
//     (`reason: 'connected'`) — so a tab whose socket reconnects after a
//     rollout learns the new build from the handshake, not its next poll;
//   * from the process being replaced, once its listener has closed, the
//     build its tabs' requests land on now (`reason: 'rollout'`; driven from
//     server.js cleanup(), covered in tests/server-graceful-shutdown.test.js).
//
// The push is to LOCAL sockets only. The pod being replaced is telling the
// tabs IT holds that their traffic has moved; the new pod's sockets learned
// its build from their handshake. Fanning out over the bus would reach only
// tabs whose answer is already in hand — and in a multi-replica rollout would
// tell a tab still served by an older pod about a build its requests may not
// reach yet.
//
// Real sockets against ws.attach, pool stubbed via require.cache — the same
// harness as tests/ws-upgrade-redispatch.test.js.
//
// Run with: node --test tests/platform-version-push.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { WebSocket } = require('ws');

const VALID_SESSION = 'valid-session-token';
const USER = { user_id: 1, username: 'evan', is_admin: true };
const BUILD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

// ── pool stub ──────────────────────────────────────────────────────────
const queries = [];
const fakePool = {
  async query(sql, params = []) {
    queries.push(sql);
    if (/FROM sessions s JOIN users u/.test(sql)) {
      if (params[0] !== VALID_SESSION) return { rows: [] };
      return {
        rows: [{ ...USER, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
      };
    }
    if (/SELECT id, collab_visibility, view_visibility FROM apps WHERE slug/.test(sql)) {
      if (params[0] === 'chatapp') {
        return { rows: [{ id: 1, collab_visibility: 'public', view_visibility: 'public' }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  },
};

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { getPool: () => fakePool },
};
delete require.cache[require.resolve('../src/services/ws')];

const ws = require('../src/services/ws');

let server;
let port;

test.before(async () => {
  const app = express();
  app.use(cookieParser());
  server = http.createServer(app);
  ws.attach(server, { jwtSecret: 'test-secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

/** An events socket that records every message it is sent, as parsed JSON. */
function openEvents() {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
    headers: { cookie: `session=${VALID_SESSION}` },
  });
  sock.received = [];
  sock.on('message', (raw) => { sock.received.push(JSON.parse(String(raw))); });
  return new Promise((resolve, reject) => {
    sock.on('open', () => resolve(sock));
    sock.on('error', reject);
    sock.on('unexpected-response', (_req, res) =>
      reject(new Error(`handshake rejected with ${res.statusCode}`)));
  });
}

function openChat() {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/chatapp`, {
    headers: { cookie: `session=${VALID_SESSION}` },
  });
  sock.received = [];
  sock.on('message', (raw) => { sock.received.push(JSON.parse(String(raw))); });
  return new Promise((resolve, reject) => {
    sock.on('open', () => resolve(sock));
    sock.on('error', reject);
  });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function withBuild(sha, run) {
  const saved = process.env.GIT_SHA;
  if (sha === null) delete process.env.GIT_SHA;
  else process.env.GIT_SHA = sha;
  return Promise.resolve().then(run).finally(() => {
    if (saved === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = saved;
  });
}

test('the first thing an events socket hears is which build it landed on', async () => {
  await withBuild(BUILD, async () => {
    const sock = await openEvents();
    await settle();
    assert.deepEqual(sock.received[0], { type: 'platform_version', sha: BUILD, reason: 'connected' },
      'the handshake carries the fact /api/version would otherwise be polled for');
    sock.terminate();
  });
});

test('a process with no build of its own says `dev`, which the client ignores', async () => {
  await withBuild(null, async () => {
    const sock = await openEvents();
    await settle();
    assert.deepEqual(sock.received[0], { type: 'platform_version', sha: 'dev', reason: 'connected' });
    sock.terminate();
  });
});

test('pushPlatformVersion tells every open events socket, and only those, and only here', async () => {
  await withBuild(BUILD, async () => {
    const a = await openEvents();
    const b = await openEvents();
    const chat = await openChat();
    await settle();
    queries.length = 0;

    const told = ws.pushPlatformVersion({ sha: NEXT });
    await settle();

    assert.equal(told, 2, 'the count is the sockets told — what cleanup() logs');
    for (const sock of [a, b]) {
      const pushed = sock.received.filter((m) => m.type === 'platform_version' && m.reason === 'rollout');
      assert.deepEqual(pushed, [{ type: 'platform_version', sha: NEXT, reason: 'rollout' }],
        'each tab is told once which build its requests land on now');
    }
    assert.deepEqual(chat.received.filter((m) => m.type === 'platform_version'), [],
      'a chat room socket is not a shell; the shell holds the events socket');
    assert.ok(!queries.some((sql) => /pg_notify/.test(sql)),
      'local sockets only — the bus would reach only tabs whose answer is already in hand');

    a.terminate(); b.terminate(); chat.terminate();
  });
});

test('nothing is pushed for no build', () => {
  assert.equal(ws.pushPlatformVersion({}), 0);
  assert.equal(ws.pushPlatformVersion(), 0);
});
