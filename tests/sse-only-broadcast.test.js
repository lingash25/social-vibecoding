'use strict';

// #394: the dev-chat turn's `send()` helper broadcasts an event on the global
// WebSocket only when its type is NOT in the SSE_ONLY set
// (`if (!SSE_ONLY.has(type)) broadcastGlobal(...)`). The Mayor's post-spec
// wrap-up summary is a `mayor_reasoning` event; it must be broadcast on the WS
// so it survives a dropped POST SSE (the global-WS `done` otherwise races
// ahead and tears down streaming before the resumable stream can replay it,
// and the summary only shows after a refresh).
//
// The suggestion chips ('suggestions') and quick-reply pills ('quick_replies',
// the "Build it" button) were later hit by the exact same race — persisted in
// the assistant row's metadata but invisible until refresh — so they are now
// broadcast on the WS too, with dedicated App.handleSessionEvent cases (the
// #437 rule: every broadcast type must have a WS handler, or the seq-dedup
// swallows the SSE copy). See tests/quick-replies-delivery.test.js for the
// client-side halves of that invariant.
//
// SSE_ONLY and send() are closures inside the route handler, so rather than
// spin up the whole streaming route we evaluate the EXACT SSE_ONLY literal out
// of the source and assert the broadcast guard is still wired the way this
// invariant assumes.
//
// Run with: node --test tests/sse-only-broadcast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #2779: the dev-chat turn moved from routes/sessions.js to services/mayor/turn.js.
const SRC = [['src', 'services', 'mayor', 'turn.js'], ['src', 'routes', 'sessions.js']]
  .map((p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')).join('\n');

function extractSseOnly() {
  const m = SRC.match(/const\s+SSE_ONLY\s*=\s*new\s+Set\(\s*(\[[^\]]*\])\s*\)/);
  assert.ok(m, 'found the SSE_ONLY = new Set([...]) literal');
  // The array literal is a plain list of string literals — eval it in a
  // bare context so the test reflects the real source verbatim.
  // eslint-disable-next-line no-eval
  return new Set(eval(m[1]));
}

test('mayor_reasoning is NOT SSE-only, so send() broadcasts it on the global WS', () => {
  const sseOnly = extractSseOnly();
  assert.equal(sseOnly.has('mayor_reasoning'), false,
    'mayor_reasoning must be broadcast on the global WS (not SSE-only) — #394');
});

test('high-frequency token streaming stays SSE-only', () => {
  const sseOnly = extractSseOnly();
  assert.equal(sseOnly.has('token'), true,
    'token stays SSE-only — it is recovered by the full-text mayor_reasoning event');
});

test('suggestions / quick_replies are NOT SSE-only, so chips and pills survive a dropped POST SSE', () => {
  const sseOnly = extractSseOnly();
  for (const t of ['suggestions', 'quick_replies']) {
    assert.equal(sseOnly.has(t), false,
      `${t} must be broadcast on the global WS — otherwise it only rides the POST SSE and shows up after a refresh`);
  }
});

test('usage / error remain SSE-only', () => {
  const sseOnly = extractSseOnly();
  for (const t of ['usage', 'error']) {
    assert.equal(sseOnly.has(t), true, `${t} stays SSE-only`);
  }
});

test('send() broadcasts on the global WS exactly when the type is not SSE-only', () => {
  // Guards that the routing mechanism this invariant depends on is intact:
  // the SSE_ONLY membership check is what gates broadcastGlobal.
  assert.match(
    SRC,
    /if\s*\(\s*!SSE_ONLY\.has\(type\)\s*\)\s*\{\s*\n\s*[\s\S]*?broadcastGlobal\(/,
    'send() still gates broadcastGlobal on !SSE_ONLY.has(type)'
  );
});

// Extract the literal object send() hands to broadcastGlobal and evaluate it
// against the same locals send() has in scope (`event`, `type`, `session`).
// This is the regression guard for #437: the payload MUST end up typed
// `session_event` (the client's `switch (data.type)` routes to
// handleSessionEvent only on that), with the real event name in `event` and
// `_seq` + data fields preserved. If a refactor lets `...event` clobber the
// envelope `type` again, this fails.
function buildBroadcastPayload(type, data, seq, sessionId) {
  const m = SRC.match(/broadcastGlobal\(\s*(\{[\s\S]*?\})\s*\)/);
  assert.ok(m, 'found the broadcastGlobal({ ... }) call literal');
  const event = { type, _seq: seq, ...data }; // eslint-disable-line no-unused-vars
  const session = { id: sessionId }; // eslint-disable-line no-unused-vars
  // eslint-disable-next-line no-eval
  return eval(`(${m[1]})`);
}

test('broadcastGlobal payload stays typed session_event with event + _seq + data preserved (#437)', () => {
  const payload = buildBroadcastPayload(
    'mayor_reasoning',
    { text: 'wrap-up summary' },
    'abc-7',
    999
  );
  assert.equal(payload.type, 'session_event',
    "broadcast envelope must be type 'session_event' so the client routes it to handleSessionEvent");
  assert.equal(payload.event, 'mayor_reasoning', 'real event name carried in `event`');
  assert.equal(payload._seq, 'abc-7', '_seq preserved for cross-channel dedup');
  assert.equal(payload.text, 'wrap-up summary', 'data fields preserved');
  assert.equal(payload.sessionId, 999, 'sessionId carried');
});

test('broadcastGlobal payload keeps type=session_event for status/done/spec_updated too (#437)', () => {
  for (const t of ['status', 'done', 'spec_updated', 'cc_progress', 'phase', 'stopped', 'stopping']) {
    const payload = buildBroadcastPayload(t, { text: 'x' }, `s-${t}`, 42);
    assert.equal(payload.type, 'session_event', `${t} envelope typed session_event`);
    assert.equal(payload.event, t, `${t} carried in event field`);
  }
});

// ── The `stopping` announcement (#889) ──────────────────────────────────
//
// POST /stop runs in a different request from the turn, so it has no access
// to the turn's `send` closure. The handle carries it, which is what lets a
// click announce itself on every channel immediately instead of ~19s later
// when the turn finally unwinds — and what makes OTHER tabs (and the phone
// app) show the stopping state at all.

test('stopping is NOT SSE-only, so every tab watching the session sees it', () => {
  const sseOnly = extractSseOnly();
  assert.equal(sseOnly.has('stopping'), false,
    'stopping must ride the global WS — otherwise only the clicking tab learns a stop is in flight');
});

test('the turn hands its send() closure to the stop handle', () => {
  // The registration literal must carry `send`, or handle.send?.() below is
  // a silent no-op and the whole cross-tab half of #889 disappears.
  // The literal closes at the turn body's indentation (two spaces since it
  // moved into runMayorTurn, #2779).
  const m = SRC.match(/const\s+stopHandle\s*=\s*\{[\s\S]*?\n {2}\};/);
  assert.ok(m, 'found the stopHandle registration literal');
  assert.match(m[0], /(^|\n)\s*send,/, 'stopHandle carries the turn send() closure');
});

test('POST /stop emits stopping with the requesting user, before the kill', () => {
  const route = SRC.slice(SRC.indexOf('async function requestSessionStop('), SRC.indexOf('async function confirmStopLanded('));
  const emit = route.search(/handle\.send\?\.\(\s*'stopping'/);
  assert.ok(emit >= 0, 'the stop route emits a stopping event');
  assert.match(route.slice(emit, emit + 200), /by:\s*user\.username/,
    'carries who requested it, so other viewers can name them');

  // Ordering: the announcement is a synchronous write + broadcast, so it
  // must sit ahead of every await in the handler. Being immediate is the
  // entire point — anything in front of it is dead air for the user.
  const kill = route.indexOf('confirmStopLanded(sessionId, handle)', emit);
  assert.ok(kill > emit, 'stopping is announced before the worker kill is dispatched');
  const disarm = route.indexOf('notify_on_done = FALSE', emit);
  assert.ok(disarm > emit, 'stopping is announced before the notify_on_done write');
});

test('the notify_on_done disarm still lands before the abort (#161)', () => {
  // #161's ordering constraint outlives #889 and is easy to lose while
  // shaving latency off this handler: abort() can unwind the Mayor stream
  // into send('done') within milliseconds, and notifySessionDone re-reads
  // this column — so the write must be awaited AND ahead of the abort, or
  // stopping a turn fires a spurious "your session finished" notification.
  const route = SRC.slice(
    SRC.indexOf('async function requestSessionStop('),
    SRC.indexOf('async function confirmStopLanded(')
  );
  const disarmIdx = route.lastIndexOf('notify_on_done = FALSE');
  assert.ok(disarmIdx > 0, 'found the disarm write');
  const abortIdx = route.indexOf('handle.abort.abort()');
  assert.ok(abortIdx > disarmIdx, 'disarm is dispatched before the abort');

  const stmt = route.slice(Math.max(0, disarmIdx - 120), disarmIdx);
  assert.ok(stmt.includes('await pool.query('),
    'the disarm is awaited, so the abort cannot race the write');
});

test('the stop route still answers with a stopped flag the client can branch on', () => {
  const route = SRC.slice(
    SRC.indexOf('async function requestSessionStop('),
    SRC.indexOf('async function confirmStopLanded(')
  );
  // The client reads all three of these: `stopped` decides whether a
  // `stopped` event is coming at all, and the two reasons drive the
  // wrap-up / already-ended branches.
  assert.match(route, /stopped:\s*false,\s*reason:\s*'no active turn'/);
  assert.match(route, /stopped:\s*false,\s*reason:\s*'wrap-up cannot be stopped'/);
  assert.match(route, /body:\s*\{\s*ok:\s*true,\s*stopped:\s*true,\s*phase:\s*handle\.phase\s*\}/);
});

test('/status exposes stopping so a reload repaints the Stopping button', () => {
  // #1378 widened the derivation: an in-process handle still answers first,
  // but a stop clicked just before a restart lives on the turn record, so
  // with no handle /status falls back to the durable stamp. Without that
  // fallback a reload repaints a calm red Stop for a turn already ending.
  assert.match(SRC, /const\s+stopHandleNow\s*=\s*stopRegistry\.get\(sessionId\);/,
    '/status still reads the live stop registry');
  assert.match(SRC, /const\s+stopping\s*=\s*stopHandleNow\s*\?\s*!!stopHandleNow\.stopped\s*:\s*!!durableStop;/,
    '/status derives stopping from the handle, falling back to the durable stop stamp');
  assert.match(SRC, /const\s+durableStop\s*=\s*turnLifecycle\.stopRequestOf\(durableTurn\);/,
    'and the durable half comes from the turn record via stopRequestOf');
  // Window widened from 200 in #907, which added runner/runnerLabel/
  // localAgent as siblings, and again for #3177's optional `delivery`; the
  // assertion below is key presence, not size.
  const payload = SRC.match(/res\.json\(\{\s*\n?\s*busy,[\s\S]{0,600}?\}\);/);
  assert.ok(payload, 'found the /status res.json payload');
  assert.match(payload[0], /\bstopping\b/, 'stopping is included in the /status payload');
});
