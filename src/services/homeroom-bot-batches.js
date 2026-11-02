'use strict';

// Homeroom bot parity, P4: working through many requests at once.
//
// "Work through these" in a chat with the bot (homeroom-bot-thread-tools/
// batch.js work_through) puts a table under the reply: one row per request,
// what the bot last found on it (its own read, when it is fresh: the verdict
// ledger in homeroom_bot_runs, with the request's track for work under way),
// and the reads it starts on those it has not read lately. Its Build button
// (homeroom-bot-cards/batch.js) starts every ready one through the same path
// start_request takes (homeroom-bot-mayor.js startRequest: the front of the
// queue, as the person, on a project the bot builds on, the membership and
// allowance rules), and the card turns into a roll-up of where those builds
// are: live, ready for a yes, in checks, building, waiting.
//
// THE ROLL-UP IS READ, NEVER KEPT. It is the requests' tracks
// (homeroom-bot-track.js tracksForRequests), the one place the
// people-facing state of a request is decided, counted. refreshBatch reads
// them again and patches the card (homeroom-bot-cards setCardState) when
// what they say changed: soon after one of the batch's requests moves
// (noteRequestChanged, from the bot's posts on a request and its ready
// cards, debounced per project), and on the bot's five-minute sweep (sweep),
// which also ends a batch whose builds have all settled or whose time is up.
//
// A BATCH MAY RAISE TWO HOLDS, for its own requests and while it runs. A
// person has `perPerson` pieces of the bot's work at once (3 by default) and
// the bot holds a project at PROPOSALS_PER_APP_CAP of its own changes open
// (5). The project's owner, one of its admins, or a platform admin, working
// through the project's requests, may go to MAX_PER_PERSON (6) at once and
// BATCH_PROPOSALS_PER_APP (10) open: raiseFor decides it at Build, the batch
// row keeps it, and the two places those holds are decided read it back for
// the batch's started requests only (the lane's picks, rules/bot-loop.ts
// bot-lane/facts.ts BATCH_RAISES_SQL; the proposal hold, homeroom-bot.js simulateCaps through
// proposalsPerAppFor). A batch ends at the latest RUN_DAYS after Build.

const log = require('./logger');

const MAX_REQUESTS = 20;
// A read of the bot's is taken as it stands when it is at most this old and
// nobody wrote on the request since; else the request is read again.
const FRESH_DAYS = 14;
// How long a batch's raise lasts at most, from its Build.
const RUN_DAYS = 3;
// The project's hold on the bot's open changes, for a batch's requests.
const BATCH_PROPOSALS_PER_APP = 10;
// A request of a batch that moved is read again this long after its last
// move (a burst of posts is one refresh).
const REFRESH_DEBOUNCE_MS = 4000;
const NOTE_CHARS = 240;
const TITLE_CHARS = 160;

// What the table says the bot found on each request.
//   ready     its last read found it ready to build (its plan may wait for
//             Build it, or a limit held its build): Build starts it
//   question  it asked a question that waits for an answer
//   person    it left it for the group to decide
//   done      what it asks is live, or there was nothing to build
//   reading   a read of it is queued or under way
//   underway  it is being built, checked, or voted on already
//   unread    it could not be read from here (the bot does not build on the
//             project, the week's building time is used up, not a member)
const READS = Object.freeze(['ready', 'question', 'person', 'done', 'reading', 'underway', 'unread']);

// A track's state, as the roll-up counts it. `active` states are work the
// batch still holds its raise for.
const BUCKET_OF = Object.freeze({
  live: 'live', done_elsewhere: 'live', going_live: 'live',
  vote: 'ready',
  checks: 'checks',
  building: 'building', planning: 'building',
  queued: 'waiting', held: 'waiting', waiting: 'waiting',
  stopped: 'stopped', closed: 'stopped',
});
const BUCKETS = Object.freeze(['live', 'ready', 'checks', 'building', 'waiting', 'stopped']);
const ACTIVE_STATES = new Set(['queued', 'planning', 'building', 'checks', 'held']);

function botModule(deps) { return deps.botSvc || require('./homeroom-bot'); }
function mayorModule(deps) { return deps.mayor || require('./homeroom-bot-mayor'); }
function liveModule(deps) { return deps.liveSvc || require('./homeroom-bot-live'); }
function dmModule(deps) { return deps.dm || require('./homeroom-bot-dm'); }
function trackModule(deps) { return deps.track || require('./homeroom-bot-track'); }
function cardsModule(deps) { return deps.cards || require('./homeroom-bot-cards'); }

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const toMs = (v) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
};

/** Pure: the request numbers a call names, as positive integers, once each, at most MAX_REQUESTS. */
function numbersOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const n = Number(typeof v === 'string' ? v.replace(/^#/, '') : v);
    if (Number.isInteger(n) && n > 0 && n <= 2147483647 && !out.includes(n)) out.push(n);
    if (out.length >= MAX_REQUESTS) break;
  }
  return out;
}

/**
 * Pure: what the table says about one request, from where its track is
 * (`track`, homeroom-bot-track.js, or null when the bot has had nothing to
 * do with it), the bot's newest verdict on it (`run`: verdict, question,
 * reason, created_at), whether a read is owed or running (`queued`), and when
 * a person last wrote on it (`personAt`). Work under way wins over an old
 * verdict; a verdict counts only while it is fresh. { read, note, why }:
 * `note` the bot's own words (its question, its reason), `why` a code the
 * card words ('plan': its plan waits for Build it; 'held': a limit held its
 * build), `closed` for a request closed since (left out of a batch).
 */
function readOf({ track = null, run = null, queued = false, personAt = null, now = Date.now() } = {}) {
  const s = track?.state || null;
  if (s === 'closed') return { read: 'done', closed: true, note: null, why: null };
  if (s === 'live' || s === 'done_elsewhere') return { read: 'done', note: null, why: 'live' };
  if (s === 'building' || s === 'checks' || s === 'vote' || s === 'going_live') return { read: 'underway', note: null, why: s };
  if (s === 'queued' && track.step === 'build') return { read: 'underway', note: null, why: 'build_queued' };
  if (s === 'queued' || s === 'planning') return { read: 'reading', note: null, why: null };
  if (s === 'waiting' && track.why === 'plan') return { read: 'ready', note: null, why: 'plan' };
  if (s === 'waiting' && track.why === 'question') {
    return { read: 'question', note: run?.verdict === 'question' && run.question ? clip(run.question, NOTE_CHARS) : null, why: null };
  }
  if (s === 'held') return { read: 'ready', note: null, why: track.why === 'allowance' ? 'allowance' : 'held' };
  if (queued) return { read: 'reading', note: null, why: null };
  const at = toMs(run?.created_at);
  const fresh = !!run && at > 0 && now - at <= FRESH_DAYS * 24 * 3600 * 1000 && !(toMs(personAt) > at);
  if (fresh) {
    if (run.verdict === 'ready') return { read: 'ready', note: null, why: null };
    if (run.verdict === 'question') return { read: 'question', note: run.question ? clip(run.question, NOTE_CHARS) : null, why: null };
    if (run.verdict === 'person') return { read: 'person', note: run.reason ? clip(run.reason, NOTE_CHARS) : null, why: null };
    if (run.verdict === 'empty') return { read: 'done', note: run.reason ? clip(run.reason, NOTE_CHARS) : null, why: 'empty' };
  }
  return { read: 'unread', note: null, why: null };
}

/** Pure: how many of each read, and the table's one-line summary ("12 requests · 9 ready · 2 questions · 1 done"). */
function countsOf(rows) {
  const counts = { total: rows.length };
  for (const read of READS) counts[read] = rows.filter((r) => r.read === read).length;
  return counts;
}

function summaryOf(counts) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return [
    `${counts.total} ${counts.total === 1 ? 'request' : 'requests'}`,
    part(counts.ready, 'ready', 'ready'),
    part(counts.question, 'question', 'questions'),
    part(counts.person, 'for the group', 'for the group'),
    part(counts.done, 'done', 'done'),
    part(counts.underway, 'under way', 'under way'),
    part(counts.reading, 'being read', 'being read'),
    part(counts.unread, 'not read', 'not read'),
  ].filter(Boolean).join(' · ');
}

/**
 * Pure: the roll-up of a running batch, from its started requests' tracks
 * (Map n → track): how many are live, ready for a yes, in checks, building,
 * waiting and stopped, each request's bucket, and how many still hold the
 * batch open (`active`). A request with no track yet is waiting.
 */
function rollupOf(numbers, tracks) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const progress = [];
  let active = 0;
  for (const n of numbers || []) {
    const track = tracks instanceof Map ? tracks.get(Number(n)) : null;
    const state = track?.state || 'queued';
    const bucket = BUCKET_OF[state] || 'waiting';
    counts[bucket] += 1;
    if (ACTIVE_STATES.has(state)) active += 1;
    progress.push({ number: Number(n), state: bucket, ...(track?.title ? { title: clip(track.title, TITLE_CHARS) } : {}) });
  }
  return { counts: { ...counts, total: progress.length }, progress, active };
}

/**
 * Pure: whether two roll-ups say the same, so an unchanged one is not pushed
 * again. Keys in any order: the stored card is JSONB, which keeps its own.
 */
function sameRollup(a, b) {
  const stable = (v) => (Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v ?? null);
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// ── Reads ────────────────────────────────────────────────────────────────

// The project, with the columns its access checks read (mayor findApp).
async function appById(pool, appId, deps = {}) {
  const { rows } = await pool.query('SELECT slug FROM apps WHERE id = $1', [Number(appId)]);
  return rows[0] ? mayorModule(deps).findApp(pool, rows[0].slug) : null;
}

/**
 * Whether `user` manages `app`: its owner, one of its admins, or a platform
 * admin who may write (app-admins.js canManageApp). A turn's user carries
 * isAdmin only, so a platform admin's write grant is read from their row.
 * Never throws.
 */
async function managesApp(pool, app, user) {
  try {
    if (!app || !user?.id) return false;
    let canAdminWrite = user.canAdminWrite === true;
    if (!canAdminWrite && user.isAdmin && user.canAdminWrite === undefined) {
      const { rows } = await pool.query(
        'SELECT (is_admin AND NOT COALESCE(admin_readonly, FALSE)) AS w FROM users WHERE id = $1', [Number(user.id)]);
      canAdminWrite = rows[0]?.w === true;
    }
    return await require('./app-admins').canManageApp(pool, app, { ...user, canAdminWrite });
  } catch {
    return false;
  }
}

/**
 * The caps a batch of `user`'s on `app` raises, or null when it raises none:
 * the project's owner, admins and platform admins only (managesApp), and
 * only past what the settings give already.
 */
async function raiseFor(pool, app, user, settings = null) {
  if (!(await managesApp(pool, app, user))) return null;
  const { MAX_PER_PERSON } = require('../workflow/rules/bot-loop.ts');
  const base = Number(settings?.perPerson) || 3;
  return {
    perPerson: base < MAX_PER_PERSON ? MAX_PER_PERSON : null,
    proposalsPerApp: BATCH_PROPOSALS_PER_APP,
    // How the card says whose limit it is.
    as: Number(app.created_by) === Number(user.id) ? 'owner' : 'admin',
  };
}

// Which of `numbers` are requests on the project at all (the records
// homeroom-bot-mayor.js requestExists reads), and which are closed.
const KNOWN_SQL = `
  SELECT x.n,
         EXISTS (SELECT 1 FROM issues c WHERE c.app_id = $1 AND c.github_issue_number = x.n
                    AND c.kind = 'general' AND c.status = 'closed')
         OR EXISTS (SELECT 1 FROM homeroom_bot_closed_requests c WHERE c.app_id = $1 AND c.issue_number = x.n
                       AND c.closed_at IS NOT NULL) AS closed
    FROM unnest($2::int[]) AS x(n)
   WHERE EXISTS (SELECT 1 FROM issues i WHERE i.app_id = $1 AND i.github_issue_number = x.n)
      OR EXISTS (SELECT 1 FROM homeroom_bot_requesters r WHERE r.app_id = $1 AND r.issue_number = x.n)
      OR EXISTS (SELECT 1 FROM homeroom_bot_queue q WHERE q.app_id = $1 AND q.issue_number = x.n)
      OR EXISTS (SELECT 1 FROM homeroom_bot_runs b WHERE b.app_id = $1 AND b.issue_number = x.n)
      OR EXISTS (SELECT 1 FROM feedback_reports f WHERE f.app_id = $1 AND f.issue_number = x.n)`;

// A person's own open requests on a project that nobody has taken: filed by
// them (or asked for, as the bot recorded it), not closed, not claimed.
const MINE_SQL = `
  SELECT x.n FROM (
    SELECT i.github_issue_number AS n FROM issues i
     WHERE i.app_id = $1 AND i.created_by = $2 AND i.kind = 'general' AND i.status <> 'closed'
       AND i.github_issue_number IS NOT NULL
    UNION
    SELECT q.issue_number FROM homeroom_bot_requesters q WHERE q.app_id = $1 AND q.user_id = $2
  ) x
   WHERE NOT EXISTS (SELECT 1 FROM issues c WHERE c.app_id = $1 AND c.github_issue_number = x.n
                        AND c.kind = 'general' AND c.status = 'closed')
     AND NOT EXISTS (SELECT 1 FROM homeroom_bot_closed_requests c WHERE c.app_id = $1 AND c.issue_number = x.n
                        AND c.closed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM issue_claims ic JOIN users u ON u.id = ic.user_id
                      WHERE ic.app_id = $1 AND ic.github_issue_number = x.n AND u.is_synthetic IS NOT TRUE)
   ORDER BY x.n DESC
   LIMIT 20`;

// What the table reads of each request: its title and requester, the bot's
// newest verdict, whether a look is owed, and when a person last wrote on it.
const TITLES_SQL = `
  SELECT x.n,
         COALESCE((SELECT NULLIF(BTRIM(i.title), '') FROM issues i WHERE i.app_id = $1 AND i.github_issue_number = x.n
                    ORDER BY i.id DESC LIMIT 1),
                  (SELECT NULLIF(BTRIM(q.issue_title), '') FROM homeroom_bot_requesters q
                    WHERE q.app_id = $1 AND q.issue_number = x.n)) AS title,
         COALESCE((SELECT q.user_id FROM homeroom_bot_requesters q WHERE q.app_id = $1 AND q.issue_number = x.n),
                  (SELECT i.created_by FROM issues i WHERE i.app_id = $1 AND i.github_issue_number = x.n
                    ORDER BY i.id LIMIT 1)) AS requester_id
    FROM unnest($2::int[]) AS x(n)`;
const RUNS_SQL = `
  SELECT DISTINCT ON (r.issue_number) r.issue_number, r.id, r.verdict, r.question, r.reason, r.created_at
    FROM homeroom_bot_runs r
   WHERE r.app_id = $1 AND r.issue_number = ANY($2::int[]) AND r.mode = 'live'
     AND r.verdict IN ('ready', 'question', 'person', 'empty')
   ORDER BY r.issue_number, r.id DESC`;
const QUEUED_SQL = 'SELECT issue_number FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = ANY($2::int[])';
const PERSON_AT_SQL = `
  SELECT m.thread_ref AS n, MAX(m.created_at) AS at
    FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
   WHERE m.app_id = $1 AND m.thread_type = 'issue' AND m.thread_ref = ANY($2::int[])
     AND m.msg_type = 'message' AND m.deleted_at IS NULL AND u.is_synthetic IS NOT TRUE
   GROUP BY m.thread_ref`;

/**
 * Which requests a work_through call is about: `numbers`, or `which` 'mine'
 * (the person's own open requests nobody has taken). Resolves { numbers,
 * unknown, closed }: what is on the project and open, in the order asked,
 * and what was left out.
 */
async function requestsFor(pool, { app, user, numbers = null, which = null }) {
  let asked = numbersOf(numbers);
  if (!asked.length && which === 'mine') {
    const { rows } = await pool.query(MINE_SQL, [Number(app.id), Number(user.id)]);
    asked = rows.map((r) => Number(r.n)).reverse();
  }
  if (!asked.length) return { numbers: [], unknown: [], closed: [] };
  const { rows } = await pool.query(KNOWN_SQL, [Number(app.id), asked]);
  const known = new Map(rows.map((r) => [Number(r.n), r.closed === true]));
  return {
    numbers: asked.filter((n) => known.has(n) && !known.get(n)),
    unknown: asked.filter((n) => !known.has(n)),
    closed: asked.filter((n) => known.get(n) === true),
  };
}

/**
 * What the bot found on each request now, read from its records: one row
 * per number { number, title, read, note, why, requesterId }, in order.
 */
async function classify(pool, { app, numbers, now = Date.now(), deps = {} }) {
  const list = numbersOf(numbers);
  if (!list.length) return [];
  const id = Number(app.id);
  const [titles, runs, queued, people, tracks] = await Promise.all([
    pool.query(TITLES_SQL, [id, list]),
    pool.query(RUNS_SQL, [id, list]),
    pool.query(QUEUED_SQL, [id, list]),
    pool.query(PERSON_AT_SQL, [id, list]),
    trackModule(deps).tracksForRequests(pool, { appId: id, numbers: list, deps: deps.trackDeps || {} }),
  ]);
  const by = (res, key = 'issue_number') => new Map((res.rows || []).map((r) => [Number(r[key]), r]));
  const titleOf = by(titles, 'n');
  const runOf = by(runs);
  const queuedSet = new Set((queued.rows || []).map((r) => Number(r.issue_number)));
  const personOf = by(people, 'n');
  return list.map((n) => {
    const track = tracks instanceof Map ? tracks.get(n) || null : null;
    const read = readOf({ track, run: runOf.get(n) || null, queued: queuedSet.has(n), personAt: personOf.get(n)?.at || null, now });
    const title = titleOf.get(n)?.title || track?.title || null;
    return {
      number: n, title: title ? clip(title, TITLE_CHARS) : null, read: read.read, note: read.note || null, why: read.why || null,
      ...(read.closed ? { closed: true } : {}),
      requesterId: Number(titleOf.get(n)?.requester_id) || null,
    };
  });
}

/**
 * Queue a read of each request the bot has not read lately, as start_request
 * would: at the front, as `user`, paid by its requester when it is theirs and
 * by `user` otherwise; only where the bot builds, a member or the requester
 * asks, and whoever pays has building time left. Resolves the rows with
 * those it queued marked `reading`, and why the others could not be.
 */
async function queueReads(pool, { app, user, rows, settings, deps = {} }) {
  const unread = rows.filter((r) => r.read === 'unread');
  if (!unread.length) return { rows, queued: [] };
  const live = liveModule(deps);
  const builds = live.isLiveFor(settings, app) && !(settings?.pausedApps || []).includes(app.slug) && settings?.mode !== 'off';
  if (!builds) return { rows: rows.map((r) => (r.read === 'unread' ? { ...r, why: 'not_built_here' } : r)), queued: [] };
  const member = await mayorModule(deps).canFile(pool, app, user);
  const dm = dmModule(deps);
  const ownSpent = await dm.overWeeklyAllowance(pool, settings, user.id).catch(() => false);
  const queued = [];
  const out = [];
  for (const r of rows) {
    if (r.read !== 'unread') { out.push(r); continue; }
    const theirs = Number(r.requesterId) === Number(user.id);
    if (!theirs && !member) { out.push({ ...r, why: 'not_member' }); continue; }
    const payer = theirs ? r.requesterId : user.id;
    const spent = theirs ? await dm.overWeeklyAllowance(pool, settings, payer).catch(() => false) : ownSpent;
    if (spent) { out.push({ ...r, why: 'allowance' }); continue; }
    try {
      await botModule(deps).enqueueFront(pool, {
        appId: app.id, issueNumber: r.number, userId: user.id, reason: 'batch_read', payerId: theirs ? null : user.id,
      });
      queued.push(r.number);
      out.push({ ...r, read: 'reading', why: null });
    } catch (err) {
      log.warn('homeroom-bot-batches', 'Could not queue a read for a batch', { app: app.slug, issueNumber: r.number, err: err.message });
      out.push(r);
    }
  }
  return { rows: out, queued };
}

/** The card's row, as stored: what the client draws. */
function cardRow(r) {
  return { number: r.number, title: r.title, read: r.read, note: r.note || null, why: r.why || null };
}

/**
 * work_through: the batch's row and card for `numbers` (or the person's own),
 * reading again what needs a read. Resolves { ok, card, rows, counts,
 * queued, unknown, closed, raise } or { ok: false, error }.
 */
async function propose(pool, { app, user, numbers = null, which = null, settings, conversationId = null, deps = {} }) {
  const asked = await requestsFor(pool, { app, user, numbers, which });
  if (!asked.numbers.length) {
    return {
      ok: false,
      error: which === 'mine' && !numbersOf(numbers).length
        ? `They have no open requests of their own on ${app.name || app.slug} that nobody has taken.`
        : `None of those is an open request on ${app.name || app.slug}. Check my_work or list_requests.`,
      ...(asked.unknown.length ? { unknown: asked.unknown } : {}),
      ...(asked.closed.length ? { closed: asked.closed } : {}),
    };
  }
  let rows = await classify(pool, { app, numbers: asked.numbers, deps });
  // Closed since (the track says so): left out like any closed request.
  const closedNow = rows.filter((r) => r.closed).map((r) => r.number);
  rows = rows.filter((r) => !r.closed);
  if (!rows.length) return { ok: false, error: `Those requests on ${app.name || app.slug} are closed.`, closed: [...asked.closed, ...closedNow] };
  const read = await queueReads(pool, { app, user, rows, settings, deps });
  rows = read.rows;
  const counts = countsOf(rows);
  const raise = await raiseFor(pool, app, user, settings);
  const { rows: [batch] } = await pool.query(
    `INSERT INTO homeroom_bot_batches (user_id, app_id, conversation_id, numbers)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [Number(user.id), Number(app.id), Number(conversationId) || null, rows.map((r) => r.number)],
  );
  const card = {
    type: 'batch', v: 1, state: 'proposed', batchId: Number(batch.id),
    project: app.slug, projectName: app.name || app.slug,
    requests: rows.map(cardRow),
    counts,
    label: summaryOf(counts),
    raise: raise ? { perPerson: raise.perPerson, proposalsPerApp: raise.proposalsPerApp, as: raise.as } : null,
  };
  return {
    ok: true, batchId: Number(batch.id), card, rows, counts, queued: read.queued,
    unknown: asked.unknown, closed: [...asked.closed, ...closedNow], raise,
  };
}

async function batchRow(pool, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_batches WHERE id = $1', [n]);
  return rows[0] || null;
}

/** The roll-up of a running batch's started requests, from their tracks. */
async function rollupFor(pool, batch, deps = {}) {
  const numbers = (batch.started_numbers || []).map(Number);
  const tracks = numbers.length
    ? await trackModule(deps).tracksForRequests(pool, { appId: Number(batch.app_id), numbers, deps: deps.trackDeps || {} })
    : new Map();
  return rollupOf(numbers, tracks);
}

/**
 * Build, tapped on a batch's card: every request it finds ready now (read
 * again from the records, not from the card) is started as start_request
 * starts one, with the batch's raised caps in place first, so the lane
 * grants them under the raise. Once per batch: a second tap is refused.
 * Resolves { ok, patch, started, refused } or { ok: false, status, error }.
 */
async function start(pool, config, { batch, user, message, deps = {} }) {
  if (!batch || Number(batch.user_id) !== Number(user.id)) return { ok: false, status: 404, error: 'No such card' };
  if (batch.state !== 'proposed') return { ok: false, status: 409, error: 'This batch has already started.' };
  const app = await appById(pool, batch.app_id, deps);
  if (!app || !(await mayorModule(deps).canView(pool, app, user))) return { ok: false, status: 404, error: 'No such card' };
  const settings = deps.settings || await botModule(deps).readSettings(pool);
  const rows = await classify(pool, { app, numbers: batch.numbers, deps });
  const ready = rows.filter((r) => r.read === 'ready' && !r.closed);
  if (!ready.length) return { ok: false, status: 409, error: 'None of them is ready to build right now.' };
  const raise = await raiseFor(pool, app, user, settings);
  // The claim: one tap starts the batch, and its raise is in place before
  // anything is queued.
  const { rows: [claimed] } = await pool.query(
    `UPDATE homeroom_bot_batches
        SET state = 'running', started_at = NOW(), ends_at = NOW() + make_interval(days => $2),
            per_person = $3, proposals_per_app = $4, started_numbers = $5,
            message_id = COALESCE(message_id, $6), conversation_id = COALESCE(conversation_id, $7)
      WHERE id = $1 AND state = 'proposed'
      RETURNING *`,
    [Number(batch.id), RUN_DAYS, raise?.perPerson || null, raise?.proposalsPerApp || null, ready.map((r) => r.number),
      Number(message?.id) || null, Number(message?.conversationId) || null],
  );
  if (!claimed) return { ok: false, status: 409, error: 'This batch has already started.' };
  const startRequest = deps.startRequest || mayorModule(deps).startRequest;
  const bot = deps.bot || { id: Number(message?.botId) || null, username: null };
  const started = [];
  const refused = [];
  for (const r of ready) {
    // A fresh turn's worth of context each: start_request starts one per turn.
    const ctx = {
      user, settings, config, bot, deps: { ...(deps.startDeps || {}) }, appIds: new Set(), cards: [],
      conversationId: Number(message?.conversationId) || null, userText: '',
    };
    let out;
    try {
      out = await startRequest(pool, ctx, { project: app.slug, number: r.number });
    } catch (err) {
      log.warn('homeroom-bot-batches', 'A batch could not start a request', { app: app.slug, issueNumber: r.number, err: err.message });
      out = { ok: false, error: 'That did not work just now.' };
    }
    if (out?.ok) started.push(r.number);
    else refused.push({ number: r.number, why: clip(out?.error || 'It could not be started.', NOTE_CHARS) });
  }
  const { rows: [now] } = await pool.query(
    `UPDATE homeroom_bot_batches SET started_numbers = $2,
            state = CASE WHEN cardinality($2::int[]) = 0 THEN 'done' ELSE state END,
            ended_at = CASE WHEN cardinality($2::int[]) = 0 THEN NOW() ELSE ended_at END
      WHERE id = $1 RETURNING *`,
    [Number(batch.id), started],
  );
  const roll = await rollupFor(pool, now, deps);
  log.info('homeroom-bot-batches', 'A batch started', {
    app: app.slug, batchId: Number(batch.id), userId: user.id, started: started.length, refused: refused.length,
    perPerson: now.per_person, proposalsPerApp: now.proposals_per_app,
  });
  return {
    ok: true,
    started: started.length,
    refused,
    patch: {
      state: started.length ? 'running' : 'done',
      started,
      refused,
      raise: now.per_person || now.proposals_per_app
        ? { perPerson: now.per_person || null, proposalsPerApp: now.proposals_per_app || null, as: raise?.as || 'owner' }
        : null,
      rollup: roll.counts,
      progress: roll.progress,
    },
  };
}

/**
 * Read a running batch's roll-up again and patch its card when it changed;
 * end the batch (its raise with it) once nothing of it is under way, or its
 * time is up. Resolves what it did, or null. Never throws.
 */
async function refreshBatch(pool, id, { deps = {}, now = Date.now() } = {}) {
  try {
    const batch = await batchRow(pool, id);
    if (batch?.state === 'proposed') return await refreshProposed(pool, batch, { deps });
    if (!batch || batch.state !== 'running') return null;
    const roll = await rollupFor(pool, batch, deps);
    const over = roll.active === 0 || (batch.ends_at && toMs(batch.ends_at) <= now);
    if (over) {
      await pool.query(
        "UPDATE homeroom_bot_batches SET state = 'done', ended_at = NOW() WHERE id = $1 AND state = 'running'",
        [Number(batch.id)],
      );
    }
    const patch = { state: over ? 'done' : 'running', rollup: roll.counts, progress: roll.progress };
    if (!batch.message_id) return { ended: over, patched: false };
    const { rows: [msg] = [] } = await pool.query(
      "SELECT metadata->'homeroomBot'->'card' AS card FROM conversation_messages WHERE id = $1", [Number(batch.message_id)]);
    const card = msg?.card || null;
    if (card && card.state === patch.state && sameRollup(card.rollup, patch.rollup) && sameRollup(card.progress, patch.progress)) {
      return { ended: over, patched: false };
    }
    const patched = await cardsModule(deps).setCardState(pool, Number(batch.message_id), patch, { userId: Number(batch.user_id), ws: deps.ws || null });
    return { ended: over, patched };
  } catch (err) {
    log.warn('homeroom-bot-batches', 'Could not refresh a batch', { batchId: id, err: err.message });
    return null;
  }
}

// The reply a batch's card is under, kept on the row once found: the card is
// sent with the reply after work_through returns, and the row is made first.
async function cardMessageOf(pool, batch) {
  if (batch.message_id) return Number(batch.message_id);
  if (!batch.conversation_id) return null;
  const { rows } = await pool.query(
    `SELECT id FROM conversation_messages
      WHERE conversation_id = $1 AND deleted_at IS NULL
        AND metadata->'homeroomBot'->'card'->>'type' = 'batch'
        AND metadata->'homeroomBot'->'card'->>'batchId' = $2
      ORDER BY id DESC LIMIT 1`,
    [Number(batch.conversation_id), String(batch.id)],
  );
  const id = Number(rows[0]?.id) || null;
  if (id) await pool.query('UPDATE homeroom_bot_batches SET message_id = $2 WHERE id = $1 AND message_id IS NULL', [batch.id, id]);
  return id;
}

/**
 * A batch not built yet, whose table has rows being read: those rows say
 * what the reads found once they have, read from the records again. Nothing
 * is queued from here. Resolves what it did. Never throws.
 */
async function refreshProposed(pool, batch, { deps = {} } = {}) {
  try {
    const messageId = await cardMessageOf(pool, batch);
    if (!messageId) return { ended: false, patched: false };
    const { rows: [msg] = [] } = await pool.query(
      "SELECT metadata->'homeroomBot'->'card' AS card FROM conversation_messages WHERE id = $1", [messageId]);
    const card = msg?.card || null;
    const before = Array.isArray(card?.requests) ? card.requests : [];
    if (card?.state !== 'proposed' || !before.some((r) => r?.read === 'reading')) return { ended: false, patched: false };
    const app = await appById(pool, batch.app_id, deps);
    if (!app) return { ended: false, patched: false };
    const rows = (await classify(pool, { app, numbers: batch.numbers, deps })).filter((r) => !r.closed);
    const requests = rows.map(cardRow);
    if (sameRollup(before, requests)) return { ended: false, patched: false };
    const counts = countsOf(rows);
    const patched = await cardsModule(deps).setCardState(pool, messageId, { requests, counts, label: summaryOf(counts) },
      { userId: Number(batch.user_id), ws: deps.ws || null });
    return { ended: false, patched };
  } catch (err) {
    log.warn('homeroom-bot-batches', 'Could not refresh a batch\'s table', { batchId: batch?.id, err: err.message });
    return null;
  }
}

/**
 * Every running batch on `appId` (all of them, when null), refreshed, and
 * the tables of the last day's batches not built yet. Never throws.
 */
async function refreshApp(pool, appId = null, { deps = {} } = {}) {
  try {
    const res = await pool.query(
      `SELECT id FROM homeroom_bot_batches
        WHERE (state = 'running' OR (state = 'proposed' AND created_at > NOW() - INTERVAL '1 day'))
          AND ($1::int IS NULL OR app_id = $1)
        ORDER BY id`,
      [appId == null ? null : Number(appId)],
    );
    const ids = Array.isArray(res?.rows) ? res.rows.map((r) => Number(r.id)) : [];
    let ended = 0;
    let patched = 0;
    for (const id of ids) {
      const out = await refreshBatch(pool, id, { deps });
      if (out?.ended) ended += 1;
      if (out?.patched) patched += 1;
    }
    return { refreshed: ids.length, ended, patched };
  } catch (err) {
    log.warn('homeroom-bot-batches', 'Could not refresh the running batches', { appId, err: err.message });
    return { refreshed: 0, ended: 0, patched: 0 };
  }
}

// One refresh per project at a time, after its last move.
const pending = new Map();

/**
 * One of the bot's requests on `appId` moved (it posted on it, its change is
 * ready): its project's running batches are read again shortly, and its
 * build notes settled (homeroom-bot-steer.js). Never throws, never waits.
 */
function noteRequestChanged(pool, appId, _issueNumber = null) {
  try {
    const id = Number(appId);
    if (!pool || typeof pool.query !== 'function' || !Number.isInteger(id) || id <= 0) return;
    const before = pending.get(id);
    if (before) clearTimeout(before);
    const timer = setTimeout(() => {
      pending.delete(id);
      refreshApp(pool, id).catch(() => {});
      require('./homeroom-bot-steer').settleNotes(pool, { appId: id }).catch(() => {});
    }, REFRESH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    pending.set(id, timer);
  } catch { /* a refresh never costs its caller */ }
}

/** The five-minute sweep's part (homeroom-bot.js sweep): every running batch, refreshed or ended. */
async function sweep(pool, deps = {}) {
  const out = await refreshApp(pool, null, { deps });
  return out.ended || out.patched ? out : null;
}

/**
 * The project's hold on the bot's open changes for request `issueNumber`
 * (homeroom-bot.js simulateCaps): a running batch's raise when the request
 * is one it started, else `base`. Never throws: a read that fails is the
 * ordinary hold.
 */
async function proposalsPerAppFor(pool, appId, issueNumber, base) {
  try {
    const n = Number(issueNumber);
    if (!Number.isInteger(n) || n <= 0) return base;
    const { rows } = await pool.query(
      `SELECT MAX(proposals_per_app)::int AS cap FROM homeroom_bot_batches
        WHERE app_id = $1 AND state = 'running' AND ends_at > NOW() AND proposals_per_app IS NOT NULL
          AND $2 = ANY(started_numbers)`,
      [Number(appId), n],
    );
    const cap = Number(rows[0]?.cap);
    return Number.isInteger(cap) && cap > base ? cap : base;
  } catch {
    return base;
  }
}

module.exports = {
  MAX_REQUESTS,
  FRESH_DAYS,
  RUN_DAYS,
  BATCH_PROPOSALS_PER_APP,
  READS,
  BUCKETS,
  numbersOf,
  readOf,
  countsOf,
  summaryOf,
  rollupOf,
  managesApp,
  raiseFor,
  requestsFor,
  classify,
  queueReads,
  propose,
  batchRow,
  start,
  refreshBatch,
  refreshApp,
  noteRequestChanged,
  sweep,
  proposalsPerAppFor,
};
