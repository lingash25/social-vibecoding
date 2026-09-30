'use strict';

// Invite redemption and friend writes answer only the Homeroom page itself:
// a browser request marked by Sec-Fetch-Site as coming from anywhere else —
// including an app on a sibling subdomain, which the Lax session cookie
// does not stop — is refused. Clients that send no such header pass.
//
// Run with: node --test tests/same-site-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { sameOriginBrowserOnly } = require('../src/middleware/same-site-browser');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function withApp(fn) {
  const app = express();
  app.post('/write', sameOriginBrowserOnly, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/write`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a browser request from another site or origin is refused with 403', async () => {
  await withApp(async (url) => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      const res = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': site } });
      assert.equal(res.status, 403, site);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
  });
});

test('the Homeroom page itself, and a client that sends no header, pass', async () => {
  await withApp(async (url) => {
    const same = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(same.status, 200);
    const bare = await fetch(url, { method: 'POST' });
    assert.equal(bare.status, 200, 'native app, CLI and tests send no Sec-Fetch-Site');
  });
});

test('invite redemption is guarded, after its rate limiter', () => {
  const src = read('src/routes/community-invites.js');
  assert.ok(src.includes(
    "router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter, sameOriginBrowserOnly, async",
  ));
});

test('every friend write is guarded', () => {
  const src = read('src/routes/friends.js');
  for (const route of [
    "router.post('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('request',",
    "router.delete('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('cancel',",
    "router.post('/api/friends/:userId/accept', friendshipLimiter, sameOriginBrowserOnly, write('accept',",
    "router.post('/api/friends/:userId/decline', friendshipLimiter, sameOriginBrowserOnly, write('decline',",
    "router.delete('/api/friends/:userId', friendshipLimiter, sameOriginBrowserOnly, write('unfriend',",
  ]) assert.ok(src.includes(route), route);
  assert.doesNotMatch(src, /router\.(post|delete)\([^\n]*friendshipLimiter, write\(/, 'no unguarded write');
});
