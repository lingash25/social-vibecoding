'use strict';

// Usage data (Settings › Privacy).
//
// Homeroom keeps a record of how it is used, linked to each account. Part of
// it the product runs on: votes, messages, requests, projects, challenges and
// the daily app use a vote's threshold counts. The rest is screen usage data,
// recorded for everyone to see where people get stuck:
//
//   ui_experience / ui_telemetry_delivery   the shell's UI telemetry
//       (services/ui-telemetry.js): screens visited and in what order, how
//       long a few actions took and whether they failed, page load times.
//       The admin Journey page reads its paths, next steps and "possibly
//       lost" visits from these rows.
//   first_session_moment   the made screen's moments
//       (services/first-session-moments.js).
//   dapp_opened            an app opened from the App tab
//       (services/app-openings.js).
//   live_build_opened / live_build_watched   watching a first version's
//       Live (services/first-version-live.js recordView).
//
// Somebody who does not want it recorded asks, at the data protection
// address the Privacy page and the privacy notice give
// (config.dataProtectionEmail). An admin adds them to Admin › Journey's
// left-out list as "objected" (services/journey-left-out.js), which erases
// what was recorded in the same transaction; from then on every write path
// below drops their events. There is no switch: #5593 (20 Oct 2026) made this
// opt-in behind "Share usage analytics" (users.usage_analytics), which
// nearly nobody switched on, and that column is no longer read.
//
// All of them go through ui-telemetry.isRecordable() or ask here directly,
// on the server, whatever the browser sends; the shell does not send them
// either (uiTelemetryEligible on /api/auth/me).

const leftOut = require('./journey-left-out');
const log = require('./logger');

/** The event types an objection stops and erases (journey-left-out.js). */
const { SCREEN_USAGE_EVENT_TYPES } = leftOut;

/**
 * Whether this account's screen usage data is recorded: true unless the
 * person objected. This is the one gate between an objection and a write,
 * so it fails closed: a list that cannot be read (journey-left-out's
 * idsByReason answers null, or throws) records nobody until the next read,
 * which costs a few seconds of optional data and never records an objector.
 * A bad id is never recorded.
 */
async function recordsUsage(pool, userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  try {
    const ids = await leftOut.idsByReason(pool);
    if (!ids) {
      log.warn('usage-analytics', 'The left-out list could not be read: recording nothing', { userId: id });
      return false;
    }
    return !ids.objected.has(id);
  } catch (err) {
    log.warn('usage-analytics', 'Could not read whether the person objected', { userId: id, err: err && err.message });
    return false;
  }
}

module.exports = {
  SCREEN_USAGE_EVENT_TYPES,
  recordsUsage,
};
