'use strict';

// Usage data (Settings > Privacy). Screen usage data is recorded for every
// account. Somebody who does not want it writes to the data protection
// address the page gives, and an admin adds them to the Journey left-out
// list as "objected", which erases it and stops it, on the server, whatever
// the browser sends. There is no switch: #5593 made the same set opt-in
// ("Share usage analytics"), and Google Analytics is gone from the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const usageAnalytics = require('../src/services/usage-analytics');
const leftOut = require('../src/services/journey-left-out');
const telemetry = require('../src/services/ui-telemetry');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const html = (text) => text.replace(/'/g, '&#x27;');

// The Journey left-out list as platform_settings stores it, and every query
// the services make, recorded. A fresh pool per test: the list is cached per
// pool.
function listPool(entries = []) {
  const calls = [];
  async function query(sql, params = []) {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT value FROM platform_settings WHERE key = \$1/.test(text)) {
      return { rows: [{ value: JSON.stringify(entries) }] };
    }
    return { rows: [], rowCount: 0 };
  }
  return { calls, query, async connect() { return { query, release() {} }; } };
}
const objected = (userId) => ({ userId, reason: 'objected', note: 'emailed', addedAt: '2026-11-09T10:00:00Z' });

async function serve(router, user, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('screen usage data is recorded for everyone but who objected', async () => {
  const pool = listPool([objected(2), { userId: 3, reason: 'test', note: '' }]);
  assert.equal(await usageAnalytics.recordsUsage(pool, 1), true, 'recorded by default');
  assert.equal(await usageAnalytics.recordsUsage(pool, 2), false, 'objected');
  assert.equal(await usageAnalytics.recordsUsage(pool, 3), true, 'a test account on the list is still recorded');
  assert.equal(await usageAnalytics.recordsUsage(pool, null), false, 'signed out');
  assert.equal(await usageAnalytics.recordsUsage(pool, 'x'), false);
  // The one gate between an objection and a write fails closed: a list that
  // cannot be read records nobody, rather than recording an objector.
  const down = { calls: [], async query() { throw new Error('connection refused'); } };
  assert.equal(await usageAnalytics.recordsUsage(down, 1), false, 'an unreadable list records nobody');
  const src = read('src/services/usage-analytics.js');
  assert.doesNotMatch(src, /usage_analytics FROM users|usage_left_out_at/, "no per-person switch is read: #5593's column is not");
  assert.equal(exists('src/db/migrations/usage-left-out.sql'), false, 'and no column for one is added');
});

test('an objection erases every kind of screen usage data in the same transaction', async () => {
  assert.deepEqual(usageAnalytics.SCREEN_USAGE_EVENT_TYPES, [
    'ui_experience', 'ui_telemetry_delivery', 'first_session_moment',
    'dapp_opened', 'live_build_opened', 'live_build_watched',
  ]);
  assert.equal(usageAnalytics.SCREEN_USAGE_EVENT_TYPES, leftOut.SCREEN_USAGE_EVENT_TYPES, 'one list');
  const src = read('src/services/journey-left-out.js');
  assert.match(src, /if \(reason === 'objected'\) \{\s*const res = await client\.query\(\s*'DELETE FROM events WHERE user_id = \$1 AND event_type = ANY\(\$2::text\[\]\)',\s*\[userId, SCREEN_USAGE_EVENT_TYPES\]/);
});

test('UI telemetry is recordable for everyone but who objected, and the collector drops theirs', async () => {
  const person = (id) => ({ id, username: `person-${id}` });
  const pool = listPool([objected(2)]);
  assert.equal(await telemetry.isRecordable(pool, person(1)), true, 'recorded by default');
  assert.equal(await telemetry.isRecordable(pool, person(2)), false, 'objected: not recorded');
  assert.equal(await telemetry.isRecordable(pool, null), false, 'signed out: not recorded');
  assert.equal(await telemetry.isRecordable(listPool(), { id: 3, username: 'usernode-capture' }), false,
    'a service account stays out');

  const off = listPool([objected(2)]);
  await telemetry.recordServerFailure(off, { user: person(2), get() { return null; } },
    { screen: 'report_dialog', action: 'content_report_submit', status: 500, message: 'x' });
  assert.equal(off.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false, 'a server-side failure note is dropped too');

  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const collector = listPool([objected(2)]);
  const now = new Date().toISOString();
  const body = {
    schemaVersion: 2,
    batchId: 'batch-0000000000000001',
    delivery: { failedBatches: 0, droppedEvents: 0 },
    events: [{
      id: 'event-00000000000000001', visitId: 'visit-00000000000000001', kind: 'screen_visit',
      screen: 'home', via: 'own', occurredAt: now, sequence: 1,
    }],
  };
  await serve(uiTelemetryRoutes({}, { pool: collector }), person(2), async (base) => {
    const res = await fetch(`${base}/api/ui-telemetry/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    const answer = await res.json();
    assert.equal(answer.discarded, true);
    assert.equal(answer.accepted, 0);
  });
  assert.equal(collector.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false, 'nothing stored');
});

test('there is no switch to save, and the session answer says only whether to send', () => {
  const auth = read('src/routes/auth.js');
  assert.doesNotMatch(auth, /\/api\/me\/usage-analytics/, 'no route for a switch');
  assert.match(auth, /uiTelemetryEligible: await uiTelemetry\.isRecordable\(pool, req\.user\),/);
  assert.doesNotMatch(auth, /analyticsCounted|justSignedUp/, 'nothing for Google Analytics');
});

test('Google Analytics is gone from the app', () => {
  for (const gone of ['public/analytics-frame.html', 'frontend/src/lib/google-analytics.ts']) {
    assert.equal(exists(gone), false, `${gone} is removed`);
  }
  for (const file of ['frontend/src/main.tsx', 'public/js/app.js', 'src/middleware/auth.js', 'src/services/ui-telemetry.js', 'frontend/src/head.html']) {
    assert.doesNotMatch(read(file), /googleAnalytics|google-analytics|analytics-frame|googletagmanager|gtag\(/i, `${file} has no trace of it`);
  }
  assert.doesNotMatch(read('src/prompts/app-conventions.md'), /Google Analytics/, 'no exception left for apps to point at');
  assert.doesNotMatch(read('AGENTS.md'), /analytics-frame/);
});

test('Settings > Privacy says what is kept and where to write to be left out, with no switch', () => {
  // #5097 + #5104: one Privacy page. Usage data is its last block, under who
  // can reach you and who can find you.
  const page = renderComponent('frontend/src/features/settings/sections/privacy.tsx', 'PrivacySection', {});
  assert.match(page, /data-settings-section="contact-privacy"/);
  assert.match(page, /id="settings-contact-privacy-section"[\s\S]*id="settings-usage-analytics-section"/,
    'after the contact settings');
  assert.doesNotMatch(page, /id="settings-usage-analytics"/, 'no switch');
  for (const id of [
    'title', 'intro', 'alwaysKept.title', 'alwaysKept.apps', 'alwaysKept.acts', 'alwaysKept.challenges',
    'alsoRecorded.title', 'alsoRecorded.screens', 'alsoRecorded.speed', 'neverRecorded', 'leaveOut.ask',
  ]) {
    assert.ok(page.includes(html(message(`settings:privacy.usageAnalytics.${id}`))), `with the ${id} line`);
  }
  assert.match(page, /<p data-usage-analytics-ask="[^"]*">[\s\S]*<a href="mailto:dataprotection@onhomeroom\.com"[^>]*>dataprotection@onhomeroom\.com<\/a>/,
    'the address, as the prerender ships it before the options arrive');
  assert.match(message('settings:privacy.usageAnalytics.neverRecorded'), /^Never recorded: what you type, or what's on your screen\.$/);
  assert.match(message('settings:privacy.usageAnalytics.alsoRecorded.title'), /for everyone: screen usage data$/);
  assert.doesNotMatch(page, /Google Analytics|Leave me out/);

  const pane = read('frontend/src/features/settings/sections/usage-analytics.tsx');
  assert.match(pane, /useWaitlistOptions\(\)\?\.data_protection_email/, "the server's address once it arrives");
  assert.doesNotMatch(pane, /fetch\(/, 'nothing to load or save');
  const settings = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(settings, /key: 'privacy'/, 'no second Privacy row');
  assert.match(settings, /\{ key: 'contact-privacy', label: 'settings:nav\.part\.contactPrivacy'/);
});

test('the data protection address is configurable and served with the legal links', () => {
  assert.match(read('src/config.js'),
    /dataProtectionEmail: \(process\.env\.PLATFORM_DATA_PROTECTION_EMAIL \|\| ''\)\.trim\(\) \|\| 'dataprotection@onhomeroom\.com',/,
    'a self-hosted deployment sets its own');
  assert.match(read('src/routes/public-api.js'),
    /data_protection_email: config\.dataProtectionEmail \|\| 'dataprotection@onhomeroom\.com',/);
});

test('the client sends usage data only on the server\'s explicit yes', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { sharesUsageAnalytics } = loadTsx('frontend/src/lib/usage-analytics.ts');
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1, uiTelemetryEligible: true } } }), true);
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1, uiTelemetryEligible: false } } }), false);
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1 } } }), false, 'before the server answered');
  assert.equal(sharesUsageAnalytics({ App: { user: null } }), false, 'signed out');
  assert.equal(sharesUsageAnalytics({}), false);
  assert.match(read('frontend/src/features/app-frame/live-band.tsx'), /if \(!sharesUsageAnalytics\(\)\) return;/,
    'watching Live is not sent either');
});
