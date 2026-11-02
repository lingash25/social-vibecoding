'use strict';

// Homeroom bot parity, P5: steering one of the bot's builds while it runs.
//
// A NOTE INTO A RUNNING BUILD. Before, something said to the bot about a
// request it was building waited for the change's first follow-up, after
// the vote had started. Now the person who asked for the request, or the
// project's owner (or an admin), can send it to the build itself
// (homeroom-bot-thread-tools/steer.js add_to_build): a row here, waiting on
// the build's run and session. The build's Claude Code Stop hook
// (worker/build-stop-hook.js) asks for the notes waiting on its session
// each time the agent tries to end its turn (POST /api/internal/sessions/
// :id/build-notes/take, with the turn's worker token: takeNotes), and when
// there are some it sends the agent back once with them as the reason. Each
// note is delivered once, and its card under the bot's reply says so
// (homeroom-bot-cards setCardState). A note whose build ended before it
// asked is `missed` (settleNotes, run soon after the bot posts on the
// request and on its five-minute sweep), and its card offers to put it in
// the change's next update instead, the follow-up a revise_proposal Post it
// starts: one tap, since that is said in the change's public discussion.
//
// STOP AND REDO. The same people can have the build stopped and the request
// done again with their note (stop_and_redo). It is offered under the reply
// first, with Stop and redo and Keep going, and nothing stops until it is
// tapped (redo): the build is stopped as the session's Stop stops it (the
// bot-build machine, as that person), its note goes on the request's
// discussion under their name (homeroom-bot-dm.js postOnRequest, which puts
// the request first in the queue), and the lost build says nothing on the
// request (homeroom-bot.js recordLostLiveBuild: redoAsked). Keep going sends
// the note into the build instead.

const log = require('./logger');

const NOTE_CHARS = 2000;
// The most notes one stop is handed (TAKE_SQL's LIMIT).
const MAX_TAKE = 10;

function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function mayorModule(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function cardsModule(deps) { return deps.cards || require('./homeroom-bot-cards'); }
function batchesModule(deps) { return deps.batches || require('./homeroom-bot-batches'); }

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pure: a note as it may be sent: trimmed, bounded, and at least two words. Null when it is not one. */
function noteText(value) {
  const text = clip(value, NOTE_CHARS);
  return text.split(/\s+/).filter(Boolean).length >= 2 ? text : null;
}

// The build of request n under way now: the newest live run, found ready,
// whose build waits its turn or runs in a session still open, not proposed,
// held, superseded or waiting for Build it.
const BUILD_SQL = `
  SELECT r.id AS run_id, r.build_session_id AS session_id, bs.status AS session_status
    FROM homeroom_bot_runs r
    LEFT JOIN chat_sessions bs ON bs.id = r.build_session_id
   WHERE r.app_id = $1 AND r.issue_number = $2 AND r.mode = 'live' AND r.verdict = 'ready'
     AND r.build_ok IS NULL AND r.proposal_session_id IS NULL AND r.cap_suppressed IS NULL
     AND r.awaiting_go_at IS NULL AND r.build_error IS NULL
     AND (r.live_build_waiting_at IS NOT NULL OR r.build_session_id IS NOT NULL)
     AND (bs.id IS NULL OR bs.status = 'active')
     AND r.created_at > NOW() - INTERVAL '7 days'
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs n
                      WHERE n.app_id = r.app_id AND n.issue_number = r.issue_number AND n.mode = 'live' AND n.id > r.id)
   ORDER BY r.id DESC
   LIMIT 1`;

/** Request n's build under way: { runId, sessionId, running } (running: its session is open), or null. */
async function buildUnderWay(pool, appId, issueNumber) {
  const { rows } = await pool.query(BUILD_SQL, [Number(appId), Number(issueNumber)]);
  const r = rows[0];
  if (!r) return null;
  const sessionId = Number(r.session_id) || null;
  return { runId: Number(r.run_id), sessionId, running: !!sessionId && r.session_status === 'active' };
}

/**
 * Whether `user` may steer the bot's build of request n on `app`: they asked
 * for it, or they manage the project (its owner, an admin of it, a platform
 * admin who may write). { ok, theirs, manages }. Never throws.
 */
async function maySteer(pool, { app, user, issueNumber, deps = {} }) {
  try {
    if (!app || !user?.id) return { ok: false, theirs: false, manages: false };
    const requester = await dmModule(deps).requesterOf(pool, app.id, Number(issueNumber)).catch(() => null);
    const theirs = !!requester && Number(requester.userId) === Number(user.id);
    const manages = theirs ? false : await batchesModule(deps).managesApp(pool, app, user);
    return { ok: theirs || manages, theirs, manages };
  } catch {
    return { ok: false, theirs: false, manages: false };
  }
}

/** A note row, waiting on `build` (or offered, for a redo). Resolves its id. */
async function addNote(pool, { app, issueNumber, build, user, note, kind = 'note', state = 'waiting', conversationId = null }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO homeroom_bot_build_notes
       (app_id, issue_number, run_id, session_id, user_id, conversation_id, note, kind, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [Number(app.id), Number(issueNumber), build?.runId || null, build?.sessionId || null, Number(user.id),
      Number(conversationId) || null, note, kind, state],
  );
  return Number(row.id);
}

async function noteRow(pool, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_build_notes WHERE id = $1', [n]);
  return rows[0] || null;
}

// The reply whose card a note is: kept on the row once found. The card is
// sent with the reply after the tool that made the note returns, so a note
// delivered within that second finds none yet; settleNotes finds it later.
async function cardMessageOf(pool, row) {
  if (row.message_id) return Number(row.message_id);
  if (!row.conversation_id) return null;
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
        AND metadata->'homeroomBot'->'card'->>'type' = 'build_note'
        AND metadata->'homeroomBot'->'card'->>'noteId' = $2
      ORDER BY id DESC LIMIT 1`,
    [Number(row.conversation_id), String(row.id)],
  );
  const id = Number(rows[0]?.id) || null;
  if (id) await pool.query('UPDATE homeroom_bot_build_notes SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [row.id, id]);
  return id;
}

/** Patch a note's card, wherever it is. Never throws. */
async function patchCard(pool, row, patch, deps = {}) {
  try {
    const messageId = await cardMessageOf(pool, row);
    if (!messageId) return false;
    return await cardsModule(deps).setCardState(pool, messageId, patch, { userId: Number(row.user_id) || null, ws: deps.ws || null });
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not update a build note\'s card', { noteId: row?.id, err: err.message });
    return false;
  }
}

// The notes waiting on a build's session, taken once each: notes on the
// session, on its run, and a note carried to the request's next build (one
// whose redo could not be posted on the request: run_id NULL).
const TAKE_SQL = `
  UPDATE homeroom_bot_build_notes n SET state = 'delivered', delivered_at = NOW(), session_id = COALESCE(n.session_id, $1)
   WHERE n.id IN (
     SELECT w.id FROM homeroom_bot_build_notes w
      WHERE w.state = 'waiting'
        AND (w.session_id = $1
          OR w.run_id IN (SELECT r.id FROM homeroom_bot_runs r WHERE r.build_session_id = $1)
          OR (w.run_id IS NULL AND w.session_id IS NULL AND EXISTS (
                SELECT 1 FROM homeroom_bot_runs r
                 WHERE r.build_session_id = $1 AND r.app_id = w.app_id AND r.issue_number = w.issue_number)))
      ORDER BY w.id
      LIMIT 10
      FOR UPDATE SKIP LOCKED)
  RETURNING n.*, (SELECT username FROM users u WHERE u.id = n.user_id) AS username`;

/**
 * The Stop hook's ask (routes/internal.js): the notes waiting on build
 * session `sessionId`, marked delivered as they are handed over, and their
 * cards told. Resolves [{ id, note, username }] oldest first.
 */
async function takeNotes(pool, sessionId, { deps = {} } = {}) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const { rows } = await pool.query(TAKE_SQL, [id]);
  const taken = rows.sort((a, b) => a.id - b.id);
  for (const row of taken) {
    await patchCard(pool, row, { state: 'delivered', deliveredAt: new Date().toISOString() }, deps);
  }
  if (taken.length) log.info('homeroom-bot-steer', 'Build notes delivered', { sessionId: id, notes: taken.length });
  return taken.map((r) => ({ id: Number(r.id), note: r.note, username: r.username || null }));
}

// Waiting notes whose build ended before it asked for them: the run built,
// failed, was replaced or let go, or its session is no longer open. A note
// carried to a request's next build (no run yet) waits a week for one.
const ENDED_SQL = `
  UPDATE homeroom_bot_build_notes n SET state = 'missed', settled_at = NOW()
    FROM homeroom_bot_build_notes w
    LEFT JOIN homeroom_bot_runs r ON r.id = w.run_id
    LEFT JOIN chat_sessions bs ON bs.id = COALESCE(w.session_id, r.build_session_id)
   WHERE n.id = w.id AND w.state = 'waiting'
     AND ($1::int IS NULL OR w.app_id = $1)
     AND (w.created_at < NOW() - INTERVAL '7 days'
          OR (w.run_id IS NOT NULL
              AND (r.id IS NULL OR r.build_ok IS NOT NULL OR r.proposal_session_id IS NOT NULL OR r.build_error IS NOT NULL
                   OR (bs.id IS NOT NULL AND bs.status <> 'active')
                   OR (r.build_session_id IS NULL AND r.live_build_waiting_at IS NULL))))
  RETURNING n.*, r.proposal_session_id AS change_id`;

// Settled notes whose card was not found when they settled (it had not been
// sent yet): told now, within a day.
const UNTOLD_SQL = `
  SELECT n.* FROM homeroom_bot_build_notes n
   WHERE n.message_id IS NULL AND n.conversation_id IS NOT NULL
     AND n.state IN ('delivered', 'missed', 'redone')
     AND COALESCE(n.settled_at, n.delivered_at, n.created_at) > NOW() - INTERVAL '1 day'
     AND ($1::int IS NULL OR n.app_id = $1)
   ORDER BY n.id
   LIMIT 50`;

// The bot's change for the request, up for a vote: where a missed note's
// next update would go.
const OPEN_CHANGE_SQL = `
  SELECT cs.id FROM chat_sessions cs JOIN users b ON b.id = cs.user_id AND b.username = 'homeroom_bot' AND b.is_synthetic
   WHERE cs.app_id = $1 AND $2 = ANY(cs.linked_issues) AND cs.status = 'promoted' AND cs.is_headless = FALSE
   ORDER BY cs.id DESC LIMIT 1`;

async function openChangeOf(pool, appId, issueNumber, hint = null) {
  if (hint) {
    const { rows } = await pool.query("SELECT id FROM chat_sessions WHERE id = $1 AND status = 'promoted'", [Number(hint)]);
    if (rows[0]) return Number(rows[0].id);
  }
  const { rows } = await pool.query(OPEN_CHANGE_SQL, [Number(appId), Number(issueNumber)]);
  return Number(rows[0]?.id) || null;
}

/** Pure: what a missed note's card says: where it can go now. */
function missedPatch(changeId) {
  return { state: 'missed', change: changeId ? { sessionId: Number(changeId) } : null };
}

/**
 * Notes whose build ended first, marked missed and their cards told (with
 * the change their next update would go to), and cards not told before.
 * `appId` null: every project. Resolves how many moved. Never throws.
 */
async function settleNotes(pool, { appId = null, deps = {} } = {}) {
  try {
    if (!pool || typeof pool.query !== 'function') return 0;
    const app = appId == null ? null : Number(appId);
    const ended = await pool.query(ENDED_SQL, [app]);
    const rows = Array.isArray(ended?.rows) ? ended.rows : [];
    for (const row of rows) {
      const changeId = await openChangeOf(pool, row.app_id, row.issue_number, row.change_id).catch(() => null);
      await patchCard(pool, row, missedPatch(changeId), deps);
    }
    const untold = await pool.query(UNTOLD_SQL, [app]);
    for (const row of Array.isArray(untold?.rows) ? untold.rows : []) {
      const patch = row.state === 'missed'
        ? missedPatch(await openChangeOf(pool, row.app_id, row.issue_number).catch(() => null))
        : { state: row.state, ...(row.delivered_at ? { deliveredAt: new Date(row.delivered_at).toISOString() } : {}) };
      await patchCard(pool, row, patch, deps);
    }
    if (rows.length) log.info('homeroom-bot-steer', 'Build notes missed: their builds ended first', { notes: rows.length, appId: app });
    return rows.length;
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not settle build notes', { appId, err: err.message });
    return 0;
  }
}

/** The five-minute sweep's part (homeroom-bot.js sweep). */
async function sweep(pool, deps = {}) {
  const n = await settleNotes(pool, { deps });
  return n || null;
}

/**
 * Whether `user` may stop the bot's build in session `sessionId` (routes/
 * sessions.js requestSessionStop, beside the session's owner and admins):
 * the build of a request they asked for, or of one on a project they
 * manage. Never throws.
 */
async function mayStopBotBuild(pool, sessionId, user, deps = {}) {
  try {
    if (!user?.id) return false;
    const { rows } = await pool.query(
      `SELECT r.app_id, r.issue_number
         FROM homeroom_bot_runs r
         JOIN chat_sessions cs ON cs.id = r.build_session_id
         JOIN users b ON b.id = cs.user_id AND b.username = 'homeroom_bot' AND b.is_synthetic
        WHERE r.build_session_id = $1 AND r.mode = 'live'
        ORDER BY r.id DESC LIMIT 1`,
      [Number(sessionId)],
    );
    if (!rows[0]) return false;
    const app = await appOf(pool, rows[0].app_id, deps);
    if (!app) return false;
    return (await maySteer(pool, { app, user, issueNumber: rows[0].issue_number, deps })).ok;
  } catch {
    return false;
  }
}

/** Whether run `runId`'s build was stopped to be redone (homeroom-bot.js recordLostLiveBuild). Never throws. */
async function redoAsked(pool, runId) {
  try {
    const { rows } = await pool.query(
      "SELECT 1 FROM homeroom_bot_build_notes WHERE run_id = $1 AND kind = 'redo' AND state = 'redone' LIMIT 1",
      [Number(runId)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function appOf(pool, appId, deps = {}) {
  const { rows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [Number(appId)]);
  return rows[0] ? mayorModule(deps).findApp(pool, rows[0].slug) : null;
}

/** The workflow's Stop of a session's turn, as the session's Stop route asks it. */
async function stopBuildTurn({ sessionId, by }) {
  return require('../workflow/platform.ts').stopWorkflowTurn({ sessionId: Number(sessionId), by: by || null });
}

/**
 * Stop and redo, tapped on its card: the build of the note's request is
 * stopped, its note posted on the request's discussion as theirs (which
 * queues the request first), and the lost build stays quiet. Resolves
 * { ok, patch } or { ok: false, status, error }.
 */
async function redo(pool, config, { row, user, message = null, deps = {} }) {
  if (!row || row.kind !== 'redo' || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'offered') return { ok: false, status: 409, error: 'That was decided already.' };
  const app = await appOf(pool, row.app_id, deps);
  if (!app || !(await mayorModule(deps).canView(pool, app, user))) return { ok: false, status: 404, error: 'No such card' };
  const n = Number(row.issue_number);
  if (!(await maySteer(pool, { app, user, issueNumber: n, deps })).ok) {
    return { ok: false, status: 403, error: 'Only whoever asked for it, or the project\'s owner, can have its build stopped.' };
  }
  if (message?.id) await pool.query('UPDATE homeroom_bot_build_notes SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [row.id, Number(message.id)]);
  const build = await buildUnderWay(pool, app.id, n);
  if (!build?.running || (row.run_id && Number(row.run_id) !== build.runId)) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'offered'", [row.id]);
    return { ok: true, gone: true, patch: { state: 'gone' } };
  }
  // The claim, before the stop: the lost build reads it and says nothing.
  const { rows: [claimed] } = await pool.query(
    `UPDATE homeroom_bot_build_notes SET state = 'redone', settled_at = NOW(), run_id = $2, session_id = $3
      WHERE id = $1 AND state = 'offered' RETURNING id`,
    [row.id, build.runId, build.sessionId],
  );
  if (!claimed) return { ok: false, status: 409, error: 'That was decided already.' };
  let stopped = null;
  try {
    stopped = await (deps.stopTurn || stopBuildTurn)({ sessionId: build.sessionId, by: user.username || null });
  } catch (err) {
    log.warn('homeroom-bot-steer', 'Could not stop a build to redo it', { sessionId: build.sessionId, err: err.message });
  }
  if (!stopped?.body?.stopped) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'offered', settled_at = NULL WHERE id = $1 AND state = 'redone'", [row.id]);
    return { ok: false, status: 503, error: 'I could not stop it just now. Try again in a minute.' };
  }
  const steer = await maySteer(pool, { app, user, issueNumber: n, deps });
  const dm = dmModule(deps);
  const posted = await dm.postOnRequest(pool, {
    user, target: { app_id: app.id, issue_number: n, question_status: null, kind: null }, text: row.note, reason: 'dm_redo', deps,
  }).catch((err) => ({ ok: false, why: err.message }));
  if (!posted?.ok) {
    // Not on the request (they cannot post there): the next build of the
    // request is handed the note at its first stop instead.
    await pool.query(
      `INSERT INTO homeroom_bot_build_notes (app_id, issue_number, user_id, conversation_id, note, kind, state)
       VALUES ($1, $2, $3, $4, $5, 'note', 'waiting')`,
      [Number(app.id), n, Number(user.id), Number(row.conversation_id) || null, row.note],
    );
  }
  // Whoever asks pays, as start_request: the requester for their own.
  await botModule(deps).enqueueFront(pool, {
    appId: app.id, issueNumber: n, userId: user.id, reason: 'dm_redo', payerId: steer.theirs ? null : user.id,
  }).catch((err) => log.warn('homeroom-bot-steer', 'Could not queue a redo', { app: app.slug, issueNumber: n, err: err.message }));
  try { require('./homeroom-bot-tray').noteWorkChanged(user.id, deps); } catch { /* the tray reads again on its own */ }
  log.info('homeroom-bot-steer', 'A build was stopped to be redone with its note', {
    app: app.slug, issueNumber: n, runId: build.runId, userId: user.id, posted: !!posted?.ok,
  });
  return { ok: true, patch: { state: 'redone', posted: !!posted?.ok } };
}

/**
 * Keep going, tapped under a Stop and redo offer: nothing stops, and the
 * note goes into the build at its next stop instead.
 */
async function keep(pool, { row, user, message = null }) {
  if (!row || row.kind !== 'redo' || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'offered') return { ok: false, status: 409, error: 'That was decided already.' };
  const build = await buildUnderWay(pool, row.app_id, row.issue_number);
  if (!build || (row.run_id && Number(row.run_id) !== build.runId)) {
    await pool.query("UPDATE homeroom_bot_build_notes SET state = 'gone', settled_at = NOW() WHERE id = $1 AND state = 'offered'", [row.id]);
    return { ok: true, gone: true, patch: { state: 'gone' } };
  }
  const { rows: [kept] } = await pool.query(
    `UPDATE homeroom_bot_build_notes SET kind = 'note', state = 'waiting', run_id = $2, session_id = $3,
            message_id = COALESCE(message_id, $4)
      WHERE id = $1 AND state = 'offered' RETURNING id`,
    [row.id, build.runId, build.sessionId, Number(message?.id) || null],
  );
  if (!kept) return { ok: false, status: 409, error: 'That was decided already.' };
  return { ok: true, patch: { state: 'waiting', kept: true } };
}

/**
 * Put it in the next update, tapped on a missed note: the note goes on the
 * change's public discussion as theirs, with revise_proposal's gates (who
 * may ask, its revisions, the week's building time), which queues its
 * follow-up. Resolves { ok, patch } or { ok: false, status, error }.
 */
async function forward(pool, config, { row, user, card, message = null, deps = {} }) {
  if (!row || Number(row.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (row.state !== 'missed') return { ok: false, status: 409, error: 'That was decided already.' };
  const changeId = await openChangeOf(pool, row.app_id, row.issue_number, card?.change?.sessionId || null);
  if (!changeId) return { ok: false, status: 409, error: 'Its change is not up for a vote any more, so there is no next update to put it in.' };
  const settings = deps.settings || await botModule(deps).readSettings(pool);
  const ctx = {
    user, settings, config, deps: { ...(deps.reviseDeps || {}) }, bot: deps.bot || { id: Number(message?.botId) || null },
    userText: row.note, cards: [], revised: false, appIds: new Set(), inPublic: true,
    conversationId: Number(row.conversation_id) || null,
  };
  const revise = deps.reviseProposal || mayorModule(deps).reviseProposal;
  const out = await revise(pool, ctx, { proposal: changeId, change: row.note });
  if (!out?.ok) return { ok: false, status: 409, error: clip(out?.error || 'It could not be sent just now.', 400) };
  await pool.query("UPDATE homeroom_bot_build_notes SET state = 'forwarded', settled_at = NOW() WHERE id = $1 AND state = 'missed'", [row.id]);
  return { ok: true, patch: { state: 'forwarded' } };
}

module.exports = {
  NOTE_CHARS,
  MAX_TAKE,
  noteText,
  buildUnderWay,
  maySteer,
  addNote,
  noteRow,
  cardMessageOf,
  takeNotes,
  settleNotes,
  missedPatch,
  sweep,
  mayStopBotBuild,
  redoAsked,
  redo,
  keep,
  forward,
};
