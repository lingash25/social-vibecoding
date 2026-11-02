'use strict';

// Homeroom bot parity, P6: red checks that are not the change's.
//
// When the fix turn on one of the bot's own changes finds that a failing
// check fails without the change too (its `cause` "not_change"), it used to
// record a checks_not_change incident and stop: 19 such hand-offs in a week,
// each a change red on somebody else's flaky test, waiting for an admin.
// Now it does what a person would, on Homeroom's own changes (the platform's
// repository, whose checks are the platform's own tests):
//
//   1. main may have fixed it: the change is brought up to date with main once
//      and its checks run again (fixed-check-sync.js syncBeforeHandOff, which
//      homeroom-bot.js runChecksFix already asks before any hand-off). Green,
//      and it carries on to its vote. (onSynced records that step.)
//   2. still failing, on the same checks: the failing test is read off the
//      check output the follow-up already reads (identifyTests), and an open
//      request on Homeroom's board that names it is found, else one is filed
//      as the bot ("Flaky check: <test>", with the evidence: the test, its
//      error line, that it fails without the change; nothing private). The
//      bot is asked to build it, outside its project's five open-proposal
//      slots (exemptFromAppCap, read by homeroom-bot.js simulateCaps), since
//      it unblocks other work. One fix per test, never two; at most
//      MAX_IN_FLIGHT across the platform, the rest waiting their turn.
//   3. once that fix merges (homeroom-bot.js noteRequestMerged, and the sweep
//      for a fix somebody else merged), every change waiting on it is brought
//      up to date with main again, which runs its checks again, or has its
//      checks run again where it cannot be. Green, it carries on to its vote.
//   4. only when that fails (no test to name, the fix failed or was closed,
//      the checks still fail with it, or WAIT_DAYS pass) is a person asked,
//      as before (the checks_not_change incident and the line on the change),
//      with the evidence, and the requester hears it, once.
//
// The requester follows it on a card in their chat with the bot, posted once
// and patched as it moves, quietly but for the end ({ type: 'checks_green',
// steps, state }, homeroom-bot-cards/checks-green.js). Each step is an
// incident of kind checks_fixing_flake, which get_homeroom_bot and the
// console's Unexpected events list. Every write here is idempotent, and none
// is a reason the caller fails: a step that could not happen hands over as
// before.

const crypto = require('node:crypto');
const log = require('./logger');
const { withoutEmDashes } = require('./em-dashes');

const MAX_IN_FLIGHT = 3;
const WAIT_DAYS = 3;
const WAIT_MS = WAIT_DAYS * 24 * 60 * 60 * 1000;
// More failing tests than this "not the change's" at once reads as something
// broader than a flaky test: a person looks.
const MAX_TESTS = 2;
const INCIDENT_KIND = 'checks_fixing_flake';
const TITLE_PREFIX = 'Flaky check: ';
const MAX_TITLE_CHARS = 200;
const MIN_NAME_CHARS = 8;
const OPEN_FLAKE_STATES = Object.freeze(['waiting', 'building']);
const ENDED_BAD = Object.freeze(['failed', 'closed', 'expired']);
const FIX_REASON = 'flaky_check';

function botModule(deps) { return deps?.botSvc || require('./homeroom-bot'); }
function dmModule(deps) { return deps?.dm || require('./homeroom-bot-dm'); }
function liveModule(deps) { return deps?.live || require('./homeroom-bot-live'); }
function cardsModule(deps) { return deps?.cards || require('./homeroom-bot-cards'); }
function incidents() { return require('./platform-incidents'); }

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ── Pure: what failed ─────────────────────────────────────────────────────

/** Pure: one test's key, the same for the same test however it was reported. */
function testKey({ file = null, name = '' } = {}) {
  const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${norm(file)}::${norm(name)}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;
// The excerpt's own heading dash (unit-suite.js excerptOfTest), by its code.
const DASH = String.fromCharCode(0x2014);
const SKIP_LINE_RE = new RegExp(`^(${DASH}|---|\\.\\.\\.|at\\s|duration_ms|location:|stack:|type:|Failing subtests|failureType:\\s*'?subtestsFailed)`);
const ERROR_LINE_RE = /(Error\b|error:|AssertionError|expected|Expected|assert|timed out|Timeout|not ok|failed|ECONN|ENOENT|TypeError|ReferenceError)/;

/**
 * Pure: the line of a test's output that says what went wrong, clipped. An
 * excerpt's own headings (a subtest's name between dashes, "Failing subtests (2): …") and its
 * stack and timing lines are passed over; what is left carries no em dash.
 */
function errorLine(text) {
  const lines = String(text || '').replace(ANSI_RE, '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !SKIP_LINE_RE.test(l));
  const hit = lines.find((l) => ERROR_LINE_RE.test(l)) || lines[0] || '';
  const said = hit.replace(/^error:\s*/i, '').replace(/^['"]|['"]$/g, '');
  return clip(withoutEmDashes(said).split(DASH).join(','), 300);
}

/**
 * Pure: the failing tests a stored checks run names, each { name, file,
 * error }, at most MAX_TESTS + 1 (one more says there were too many). The
 * repo unit suite is one row for thousands of tests: its failing tests are
 * read from its per-test excerpts (failureDetails), else its grouped reason.
 * Any other failing row that blocks the change is a test of its own.
 */
function identifyTests(testResults, failing = []) {
  const unit = require('./unit-suite-row');
  let rows = testResults;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = null; }
  }
  rows = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const out = new Map();
  const add = (t) => {
    const name = clip(t.name, 240);
    if (!name || out.size > MAX_TESTS) return;
    const entry = { name, file: t.file ? clip(t.file, 240) : null, error: errorLine(t.error) };
    const key = testKey(entry);
    if (!out.has(key)) out.set(key, entry);
  };
  for (const row of rows) {
    if (row.status === 'pass' || row.advisory) continue;
    if (unit.isUnitSuiteRow(row)) {
      if (unit.isNotRunRow(row)) continue;
      const details = (Array.isArray(row.failureDetails) ? row.failureDetails : []).filter((d) => d && d.test);
      if (details.length) {
        for (const d of details) add({ name: d.test, file: d.file || null, error: d.excerpt || d.error || '' });
      } else {
        const named = unit.unitSuiteFailures([row], { max: MAX_TESTS + 1 });
        for (const f of named?.first || []) add({ name: f.test, file: f.file, error: '' });
      }
      continue;
    }
    const reason = String(row.failureReason || (Array.isArray(row.consoleErrors) && row.consoleErrors[0]?.message) || '');
    add({ name: row.name || row.path || '', file: row.path || null, error: reason });
  }
  // A caller's own list, when the run's rows were not to hand.
  if (!rows.length) for (const f of failing || []) add({ name: f.name, file: f.path || null, error: f.reason || '' });
  return [...out.values()];
}

/** Pure: whether every test in `now` is one the change already failed (`before`). */
function sameTests(now, before) {
  const had = new Set((Array.isArray(before) ? before : []).map(testKey));
  return now.length > 0 && now.every((t) => had.has(testKey(t)));
}

/**
 * Pure: the next step on the ladder for a change whose failing checks its fix
 * turn says are not its own.
 *   { do: 'as_today', why }   not this module's (not Homeroom's own change, or
 *                             a fix's own change): handed over as before
 *   { do: 'person', why }     the ladder ran out: a person takes it
 *   { do: 'wait' }            its fixes are under way: nothing more to do now
 *   { do: 'fix', tests }      find or file a fix for each test
 */
function nextStep({ platform = true, ownFix = false, wait = null, tests = [], flakes = [], now = Date.now() } = {}) {
  if (!platform) return { do: 'as_today', why: 'not_platform' };
  if (ownFix) return { do: 'as_today', why: 'own_fix' };
  if (wait && !wait.ended_at && wait.started_at && now - new Date(wait.started_at).getTime() > WAIT_MS) {
    return { do: 'person', why: 'too_long' };
  }
  if (wait?.stage === 'rechecking') return { do: 'person', why: 'still_fails' };
  const bad = flakes.find((f) => ENDED_BAD.includes(f.state));
  if (bad) return { do: 'person', why: `fix_${bad.state}` };
  if (wait?.stage === 'fixing' && flakes.length && flakes.every((f) => OPEN_FLAKE_STATES.includes(f.state) || f.state === 'merged')) {
    return { do: 'wait' };
  }
  if (!tests.length) return { do: 'person', why: 'no_test' };
  if (tests.length > MAX_TESTS) return { do: 'person', why: 'too_many' };
  return { do: 'fix', tests };
}

// Why a person is asked, as the end of a sentence.
const PERSON_WHY = Object.freeze({
  no_test: 'I couldn\'t tell which check fails from what the checks reported',
  too_many: 'several checks fail at once, which looks like more than one flaky check',
  still_fails: 'the fix for the failing check is in, and this change\'s checks still fail',
  fix_failed: 'the fix for the failing check did not go through',
  fix_closed: 'the request for the fix was closed without one',
  fix_expired: `nothing fixed the failing check within ${WAIT_DAYS} days`,
  too_long: `nothing fixed the failing check within ${WAIT_DAYS} days`,
  not_live: 'I don\'t build on Homeroom\'s own board right now, so nobody is fixing it',
  no_board: 'Homeroom\'s own board isn\'t available right now',
});

function personWhy(why) {
  return PERSON_WHY[why] || 'I couldn\'t get it fixed on my own';
}

/** Pure: the request a flaky check is filed as: its title. */
function flakeTitle(test) {
  return clip(`${TITLE_PREFIX}${String(test?.name || '').replace(/\s+/g, ' ').trim()}`, MAX_TITLE_CHARS);
}

/** Pure: the marker in the body of a request the bot filed for a test, which finds it again after a restart. */
function flakeMarker(test) {
  return `<!-- homeroom-bot:flaky-check ${crypto.createHash('sha256').update(testKey(test)).digest('hex').slice(0, 16)} -->`;
}

/**
 * Pure: the request's body. Homeroom's board is public, so it says only what
 * the platform's own checks said about its own test: the test, where it is,
 * its error line, and that it fails without the change.
 */
function flakeBody(test) {
  const where = test.file ? ` (${test.file})` : '';
  return [
    `The check "${test.name}"${where} failed on a change of Homeroom bot's that does not touch it, and it still failed once that change was brought up to date with main. So the failure is the check's own, not the change's: it fails without the change too.`,
    '',
    ...(test.error ? ['What it reported:', '', `    ${test.error}`, ''] : []),
    'Please make this check reliable: find why it fails here (timing, order, shared state, a fixture) and fix the check or the code it tests. Do not loosen it, skip it or delete it.',
    '',
    'Changes waiting on this fix have their checks run again once it is in.',
    '',
    flakeMarker(test),
  ].join('\n');
}

// ── Pure: the card ────────────────────────────────────────────────────────

const step = (state, what, request = null) => ({ state, what, ...(request ? { request } : {}) });

/**
 * Pure: the checks_green card for where a change stands: { type, v, state,
 * steps: [{ state: done | now | todo | failed, what, request? }], change,
 * fix? }. `wait` is its homeroom_bot_flake_waits row, `flakes` its fixes
 * (with `project`, and `fixSessionId` / `fixPrNumber` once a fix is up for a
 * vote), `syncWhy` why it was not brought up to date when it was not.
 */
function cardFor({ wait, flakes = [], change, platformSlug, syncWhy = null }) {
  const stage = wait?.stage || 'synced';
  const steps = [];
  if (stage === 'synced') {
    steps.push(step('now', 'Bringing it up to date with main, then running its checks again'));
    steps.push(step('todo', 'If the check still fails: find it, and get it fixed'));
  } else {
    steps.push(step('done', wait?.synced
      ? 'Brought it up to date with main: the check still failed'
      : syncWhy === 'level' || !syncWhy ? 'It was already up to date with main' : 'Main could not be brought into it cleanly'));
  }
  const tests = Array.isArray(wait?.tests) ? wait.tests : [];
  if (stage !== 'synced') {
    for (const t of tests) steps.push(step('done', `Found the failing check: "${clip(t.name, 120)}". It fails without this change too`));
  }
  let fix = null;
  for (const f of flakes) {
    const request = { project: f.project || platformSlug, number: Number(f.issue_number) };
    steps.push(step('done', f.filed
      ? `Filed it on Homeroom's board: "${flakeTitle({ name: f.test_name })}"`
      : `Found it on Homeroom's board already: #${Number(f.issue_number)}`, request));
    if (f.state === 'waiting') steps.push(step('now', 'Waiting its turn: other checks like it are being fixed first', request));
    else if (f.state === 'building') steps.push(step('now', `Fixing #${Number(f.issue_number)}: the fix goes to a vote on Homeroom`, request));
    else if (f.state === 'merged') steps.push(step('done', `The fix for #${Number(f.issue_number)} is in`, request));
    else steps.push(step('failed', `The fix for #${Number(f.issue_number)} did not go through`, request));
    if (!fix) {
      fix = {
        project: request.project, number: request.number,
        ...(f.fixSessionId ? { sessionId: Number(f.fixSessionId) } : {}),
        ...(f.fixPrNumber ? { prNumber: Number(f.fixPrNumber) } : {}),
      };
    }
  }
  if (stage === 'fixing') steps.push(step('todo', 'Run this change\'s checks again once the fix is in'));
  if (stage === 'rechecking') steps.push(step('now', 'Running this change\'s checks again with the fix'));
  let state = 'working';
  if (stage === 'green') {
    state = 'green';
    for (const s of steps) if (s.state === 'now' || s.state === 'todo') s.state = 'done';
    steps.push(step('done', 'Its checks pass now: it carries on to its vote'));
  }
  if (stage === 'person') {
    state = 'person';
    for (const s of steps) if (s.state === 'now') s.state = 'failed';
    const left = steps.filter((s) => s.state !== 'todo');
    steps.length = 0;
    steps.push(...left, step('failed', `A person needs to look at it: ${personWhy(wait?.why)}`));
  }
  return {
    type: 'checks_green', v: 1, state, steps: steps.slice(0, 12),
    change: { project: change?.slug || null, sessionId: Number(change?.id) || null, ...(change?.pr_number ? { prNumber: Number(change.pr_number) } : {}) },
    ...(fix ? { fix } : {}),
  };
}

/** Pure: what the change's own discussion hears when a fix is on its way. */
function fixingText({ flakes = [] } = {}) {
  const numbers = flakes.map((f) => `#${Number(f.issue_number)}`);
  const which = numbers.length > 1 ? `requests ${numbers.join(' and ')}` : `request ${numbers[0] || ''}`.trim();
  return `This change's failing check fails without it too, so I'm getting the check itself fixed (${which} on Homeroom's board). `
    + 'Its checks run again once that fix is in, and the votes it has keep counting.';
}

/** Pure: the hand-off's line on the change, with what was tried. */
function personText({ wait = null, flakes = [], why = null, failingCount = 0 } = {}) {
  const names = (Array.isArray(wait?.tests) ? wait.tests : []).map((t) => `"${clip(t.name, 80)}"`).slice(0, 2);
  const lead = failingCount === 1 || names.length === 1
    ? `The failing check${names.length === 1 ? ` ${names[0]}` : ''} on this change isn't caused by it: it fails without it too.`
    : `The failing checks${names.length ? ` ${names.join(' and ')}` : ''} on this change aren't caused by it: they fail without it too.`;
  const tried = [];
  if (wait?.synced) tried.push('brought it up to date with main');
  if (flakes.length) tried.push(`asked for the check to be fixed (${flakes.map((f) => `#${Number(f.issue_number)}`).join(', ')})`);
  const did = tried.length ? ` I ${tried.join(' and ')}, but ${personWhy(why)}.` : ` ${personWhy(why).replace(/^./, (c) => c.toUpperCase())}.`;
  return `${lead}${did} I've flagged it to Homeroom's admins, who look after the checks.`;
}

// ── Reads ─────────────────────────────────────────────────────────────────

async function platformSlugs(pool, deps) {
  try { return await botModule(deps).platformAppSlugs(pool); } catch { return [botModule(deps).PLATFORM_SELF_APP_SLUG]; }
}

async function isPlatformApp(pool, app, deps) {
  return !!app?.slug && (await platformSlugs(pool, deps)).includes(app.slug);
}

async function platformBoard(pool, deps) {
  const slug = botModule(deps).PLATFORM_SELF_APP_SLUG || 'usernode-2d5619';
  const { rows: [app] } = await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE slug = $1', [slug]);
  return app || null;
}

async function waitOf(pool, sessionId) {
  const { rows: [w] } = await pool.query('SELECT * FROM homeroom_bot_flake_waits WHERE session_id = $1', [Number(sessionId)]);
  return w || null;
}

async function flakesOf(pool, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0);
  if (!list.length) return [];
  const { rows } = await pool.query(
    `SELECT f.*, a.slug AS project,
            (SELECT cs.id FROM chat_sessions cs
              WHERE cs.app_id = f.app_id AND f.issue_number = ANY(cs.linked_issues) AND cs.status IN ('promoted', 'merging')
              ORDER BY cs.id DESC LIMIT 1) AS "fixSessionId",
            (SELECT cs.pr_number FROM chat_sessions cs
              WHERE cs.app_id = f.app_id AND f.issue_number = ANY(cs.linked_issues) AND cs.status IN ('promoted', 'merging')
              ORDER BY cs.id DESC LIMIT 1) AS "fixPrNumber"
       FROM homeroom_bot_flake_fixes f JOIN apps a ON a.id = f.app_id
      WHERE f.id = ANY($1::int[]) ORDER BY f.id`,
    [list],
  );
  return rows;
}

/** Whether `issueNumber` on `appId` is a flaky check's fix the bot is building: the exemption from its project's slots. */
async function exemptFromAppCap(pool, appId, issueNumber) {
  const n = Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM homeroom_bot_flake_fixes
      WHERE app_id = $1 AND issue_number = $2 AND state = 'building' AND ended_at IS NULL LIMIT 1`,
    [Number(appId), n],
  );
  return rows.length > 0;
}

/** The open fix a change is itself for, if it is one (its linked request is a flaky check's). */
async function ownFixOf(pool, session) {
  const issues = (Array.isArray(session?.linked_issues) ? session.linked_issues : []).map(Number).filter((n) => n > 0);
  if (!issues.length) return null;
  const { rows: [f] } = await pool.query(
    `SELECT * FROM homeroom_bot_flake_fixes
      WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND ended_at IS NULL ORDER BY id LIMIT 1`,
    [Number(session.app_id), issues],
  );
  return f || null;
}

async function changeRow(pool, sessionId) {
  const { rows: [r] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.pr_number, cs.linked_issues, cs.check_state, cs.checks_commit_sha,
            cs.reviewed_head_sha, cs.checks_checked_at, cs.test_results, a.slug, a.name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  return r || null;
}

// ── Writes ────────────────────────────────────────────────────────────────

/** One step, where admins read the platform's incidents (get_homeroom_bot). Never throws. */
async function recordStep(pool, { appId, sessionId, outcome, runId = null, issueNumber = null, why = null, test = null }) {
  try {
    await incidents().record(pool, {
      kind: INCIDENT_KIND, appId, sessionId,
      detail: {
        outcome, runId: runId || null, issueNumber: issueNumber || null,
        why: why ? clip(why, 300) : null, ...(test ? { test: clip(test, 200) } : {}),
      },
    });
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not record a step', { sessionId, outcome, err: err.message });
  }
}

async function saveWait(pool, w) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO homeroom_bot_flake_waits (session_id, app_id, issue_number, stage, synced, flake_ids, tests, head_sha, why)
     VALUES ($1, $2, $3, $4, $5, $6::int[], $7::jsonb, $8, $9)
     ON CONFLICT (session_id) DO UPDATE SET
       stage = EXCLUDED.stage, synced = homeroom_bot_flake_waits.synced OR EXCLUDED.synced,
       flake_ids = EXCLUDED.flake_ids, tests = EXCLUDED.tests, head_sha = EXCLUDED.head_sha, why = EXCLUDED.why,
       updated_at = NOW(),
       -- A change that comes back after it ended starts its ladder again,
       -- with a card of its own.
       card_message_id = CASE WHEN homeroom_bot_flake_waits.ended_at IS NOT NULL THEN NULL ELSE homeroom_bot_flake_waits.card_message_id END,
       ended_at = NULL,
       started_at = CASE WHEN homeroom_bot_flake_waits.ended_at IS NOT NULL THEN NOW() ELSE homeroom_bot_flake_waits.started_at END
     RETURNING *`,
    [Number(w.sessionId), Number(w.appId), w.issueNumber || null, w.stage, !!w.synced,
      (w.flakeIds || []).map(Number), JSON.stringify(w.tests || []), w.head ? String(w.head).toLowerCase() : null, w.why || null],
  );
  return row;
}

async function setStage(pool, sessionId, stage, { why = null, end = false, rechecked = false, head = null } = {}) {
  const { rows: [row] } = await pool.query(
    `UPDATE homeroom_bot_flake_waits
        SET stage = $2, why = COALESCE($3, why), updated_at = NOW(),
            ended_at = CASE WHEN $4::boolean THEN NOW() ELSE ended_at END,
            rechecked_at = CASE WHEN $5::boolean THEN NOW() ELSE rechecked_at END,
            head_sha = COALESCE($6, head_sha)
      WHERE session_id = $1 RETURNING *`,
    [Number(sessionId), stage, why, end, rechecked, head ? String(head).toLowerCase() : null],
  );
  return row || null;
}

/**
 * The card in the change's requester's chat with the bot: posted once, in
 * the request's story, quietly, then patched as the ladder moves. Never throws.
 */
async function showCard(pool, { wait, change, syncWhy = null, deps = {} }) {
  try {
    if (!wait) return null;
    const flakes = await flakesOf(pool, wait.flake_ids);
    const card = cardFor({ wait, flakes, change, platformSlug: botModule(deps).PLATFORM_SELF_APP_SLUG, syncWhy });
    if (wait.card_message_id) {
      await cardsModule(deps).setCardState(pool, Number(wait.card_message_id), card, { userId: wait.card_user_id, ws: deps.ws || null });
      return { messageId: Number(wait.card_message_id), card };
    }
    const dm = dmModule(deps);
    const issueNumber = Number(wait.issue_number);
    if (!(issueNumber > 0)) return null;
    const requester = await dm.requesterOf(pool, Number(change.app_id), issueNumber).catch(() => null);
    const settings = await botModule(deps).readSettings(pool).catch(() => null);
    if (!requester || !dm.hasBot(settings, requester)) return null;
    const bot = deps.bot || await dm.botAccount(pool);
    if (!bot?.id) return null;
    const shown = typeof dm.cardShown === 'function'
      ? await dm.cardShown(pool, requester.userId, Number(change.app_id), issueNumber).catch(() => null) : null;
    const sent = await dm.sendDm(pool, {
      bot, userId: requester.userId, moment: null,
      ...(shown ? { threadRootId: shown.messageId } : { threadRootId: false }),
      idempotencyKey: `hrbot-checks-green-${Number(change.id)}-${new Date(wait.started_at || Date.now()).getTime()}`,
      content: 'Its checks are failing on something that isn\'t the change. I\'m working through it:',
      metadata: {
        kind: 'step', step: 'checks_green', appSlug: change.slug, appName: change.name || change.slug, issueNumber,
        ...(requester.issueTitle && !requester.firstVersion ? { issueTitle: requester.issueTitle } : {}),
        card,
      },
    });
    if (sent?.messageId) {
      await pool.query(
        'UPDATE homeroom_bot_flake_waits SET card_message_id = $2, card_user_id = $3 WHERE session_id = $1',
        [Number(change.id), Number(sent.messageId), Number(requester.userId)],
      );
    }
    return sent?.messageId ? { messageId: Number(sent.messageId), card } : null;
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not show the checks card', { sessionId: change?.id, err: err.message });
    return null;
  }
}

/** A line in the change's own discussion, where the group votes. Never throws. */
async function noteOnChange(pool, { change, kind, text, runId = null, deps = {} }) {
  try {
    const bot = deps.bot || await dmModule(deps).botAccount(pool);
    if (!bot?.id) return;
    const issueNumber = (Array.isArray(change.linked_issues) ? Number(change.linked_issues[0]) : 0) || 0;
    await liveModule(deps).postOnProposal({
      pool, ws: deps.ws || require('./ws'), app: { id: Number(change.app_id), slug: change.slug }, issueNumber, runId,
      kind, text, bot, sessionId: Number(change.id),
    });
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not say a line on the change', { sessionId: change?.id, kind, err: err.message });
  }
}

/** The requester hears the end, once, ringing: a person needs to look. Never throws. */
async function ringPerson(pool, { change, wait, text, deps = {} }) {
  try {
    const dm = dmModule(deps);
    const issueNumber = Number(wait?.issue_number);
    if (!(issueNumber > 0)) return null;
    const requester = await dm.requesterOf(pool, Number(change.app_id), issueNumber).catch(() => null);
    const settings = await botModule(deps).readSettings(pool).catch(() => null);
    if (!requester || !dm.hasBot(settings, requester)) return null;
    const bot = deps.bot || await dm.botAccount(pool);
    if (!bot?.id) return null;
    const shown = typeof dm.cardShown === 'function'
      ? await dm.cardShown(pool, requester.userId, Number(change.app_id), issueNumber).catch(() => null) : null;
    const sent = await dm.sendDm(pool, {
      bot, userId: requester.userId,
      ...(shown ? { threadRootId: shown.messageId } : { threadRootId: false }),
      idempotencyKey: `hrbot-flaky-person-${Number(change.id)}-${String(wait.head_sha || '').slice(0, 12)}`,
      content: `I can't get this change past its checks on my own: ${text} A person needs to look at it from here.`,
      metadata: {
        kind: 'needs_look', appSlug: change.slug, appName: change.name || change.slug, issueNumber,
        ...(requester.issueTitle && !requester.firstVersion ? { issueTitle: requester.issueTitle } : {}),
      },
    });
    if (sent?.messageId) {
      await pool.query(
        `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, run_id)
         VALUES ($1, $2, $3, $4, $5, 'needs_look', NULL) ON CONFLICT (message_id) DO NOTHING`,
        [sent.messageId, requester.userId, sent.conversationId, Number(change.app_id), issueNumber],
      ).catch(() => {});
    }
    return sent;
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not tell the requester a person is needed', { sessionId: change?.id, err: err.message });
    return null;
  }
}

/**
 * Hand a waiting change to a person (step 4). From runChecksFix's hand-off
 * (`fromHandOff`) the caller records the checks_not_change incident and says
 * the line on the change, with `text`; from the sweep this does both. Ends
 * the wait, patches the card, rings the requester once. Resolves the line.
 */
async function toPerson(pool, { change, wait, why, runId = null, failingCount = 0, fromHandOff = false, deps = {} }) {
  const ended = await setStage(pool, change.id, 'person', { why, end: true }) || { ...wait, stage: 'person', why };
  const flakes = await flakesOf(pool, ended.flake_ids);
  const text = personText({ wait: ended, flakes, why, failingCount: failingCount || (Array.isArray(ended.tests) ? ended.tests.length : 1) || 1 });
  await showCard(pool, { wait: ended, change, deps });
  await recordStep(pool, { appId: change.app_id, sessionId: change.id, outcome: 'person', runId, why: personWhy(why) });
  if (!fromHandOff) {
    await incidents().record(pool, {
      kind: incidents().KINDS.CHECKS_NOT_CHANGE, appId: change.app_id, sessionId: change.id,
      detail: { runId, issueNumber: ended.issue_number || null, head: ended.head_sha || null, why: clip(personWhy(why), 300) },
    }).catch(() => {});
    await noteOnChange(pool, { change, kind: 'checks_not_change', text, runId, deps });
  }
  await ringPerson(pool, { change, wait: ended, text: `${personWhy(why).replace(/^./, (c) => c.toUpperCase())}.`, deps });
  log.info('homeroom-bot-flaky', 'Handed a change whose check is not its own to a person', { sessionId: change.id, why });
  return text;
}

/** Find the open request on `board` that names `test`, or file one as the bot. Resolves { number, filed }. */
async function findOrFile(pool, { board, test, bot, deps = {} }) {
  const marker = flakeMarker(test);
  const { rows: [ours] } = await pool.query(
    `SELECT number FROM requests WHERE app_id = $1 AND state = 'open' AND strpos(body, $2) > 0 ORDER BY number DESC LIMIT 1`,
    [board.id, marker],
  );
  if (ours) return { number: Number(ours.number), filed: true };
  if (String(test.name).length >= MIN_NAME_CHARS) {
    const { rows: [named] } = await pool.query(
      `SELECT number FROM requests
        WHERE app_id = $1 AND state = 'open'
          AND (strpos(lower(title), lower($2)) > 0 OR strpos(lower(body), lower($2)) > 0)
        ORDER BY (strpos(lower(title), lower($2)) > 0) DESC, number DESC LIMIT 1`,
      [board.id, String(test.name)],
    );
    if (named) return { number: Number(named.number), filed: false };
  }
  const github = deps.github || require('./github');
  const repo = require('./repo-ref').ownerRepo(board.repo_url);
  if (!repo || !github.isEnabled()) throw new Error('board_unavailable');
  const title = flakeTitle(test);
  const body = flakeBody(test);
  const created = await github.createIssue(repo.owner, repo.repo, { title, body, createdBy: bot?.id || null });
  const number = Number(created?.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error('invalid issue number');
  const { rows: [issue] } = await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, $2, $3, $4, 'general', $5, $6) RETURNING id`,
    [board.id, number, title, body, JSON.stringify({ fileKey: `flaky-check:${testKey(test)}`.slice(0, 300) }), bot?.id || null],
  );
  const ws = deps.ws || require('./ws');
  await Promise.resolve(ws.sendSystemMessage(pool, board.id, `${bot?.username || 'homeroom_bot'} created issue: "${title}" (#${number})`,
    'system', null, { type: 'issue', ref: number })).catch(() => {});
  try { ws.pushIssueUpdate?.({ action: 'created', appSlug: board.slug, appId: board.id, issueId: issue?.id, kind: 'general' }); } catch {}
  log.info('homeroom-bot-flaky', 'Filed a flaky check on Homeroom\'s board', { number, test: test.name });
  return { number, filed: true };
}

async function inFlight(pool) {
  const { rows: [r] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM homeroom_bot_flake_fixes WHERE state = 'building' AND ended_at IS NULL");
  return Number(r?.n) || 0;
}

/**
 * Ask the bot to build a fix (its request owed a look). Building first, so
 * the look that reads it is already outside its project's slots; back to
 * waiting if the ask could not be made.
 */
async function startBuilding(pool, flake, { deps = {} } = {}) {
  const { rows: [row] } = await pool.query(
    `UPDATE homeroom_bot_flake_fixes SET state = 'building', updated_at = NOW()
      WHERE id = $1 AND ended_at IS NULL RETURNING *`, [Number(flake.id)]);
  if (!row) return flake;
  const owe = deps.enqueue || ((args) => botModule(deps).enqueueFront(pool, args));
  try {
    await owe({ appId: Number(flake.app_id), issueNumber: Number(flake.issue_number), reason: FIX_REASON, db: pool, key: `flaky-fix:${Number(flake.id)}` });
  } catch (err) {
    await pool.query(
      "UPDATE homeroom_bot_flake_fixes SET state = 'waiting', updated_at = NOW() WHERE id = $1 AND ended_at IS NULL", [Number(flake.id)]);
    throw err;
  }
  return row;
}

/** One open fix for `test` on `board`: the one there is, else a new one (found or filed). */
async function fixFor(pool, { board, test, bot, deps = {} }) {
  const key = testKey(test);
  const { rows: [open] } = await pool.query(
    'SELECT * FROM homeroom_bot_flake_fixes WHERE test_key = $1 AND ended_at IS NULL', [key]);
  if (open) return { flake: open, fresh: false };
  const { number, filed } = await findOrFile(pool, { board, test, bot, deps });
  const { rows: [made] } = await pool.query(
    `INSERT INTO homeroom_bot_flake_fixes (test_key, test_name, test_file, app_id, issue_number, filed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (test_key) WHERE ended_at IS NULL DO NOTHING RETURNING *`,
    [key, clip(test.name, 400), test.file || null, board.id, number, filed],
  );
  if (made) return { flake: made, fresh: true };
  // Another look made it between the read and the write.
  const { rows: [raced] } = await pool.query(
    'SELECT * FROM homeroom_bot_flake_fixes WHERE test_key = $1 AND ended_at IS NULL', [key]);
  return { flake: raced, fresh: false };
}

// ── The ladder's entry points (homeroom-bot.js runChecksFix) ──────────────

/**
 * Step 1 happened: a change whose check its fix turn said is not its own was
 * brought up to date with main, and its checks run again. Recorded, with the
 * tests it failed, so the next round on the new head goes straight on, and
 * the requester's card says so. Never throws.
 */
async function onSynced(pool, { app, session, head, failing = [], runId = null, deps = {} } = {}) {
  try {
    if (!(await isPlatformApp(pool, app, deps))) return null;
    const change = await changeRow(pool, session.id);
    if (!change || await ownFixOf(pool, change)) return null;
    const tests = identifyTests(change.test_results, failing);
    const issueNumber = Array.isArray(change.linked_issues) ? Number(change.linked_issues[0]) || null : null;
    const wait = await saveWait(pool, {
      sessionId: change.id, appId: change.app_id, issueNumber, stage: 'synced', synced: true, flakeIds: [], tests, head,
    });
    await recordStep(pool, { appId: change.app_id, sessionId: change.id, outcome: 'synced', runId, test: tests[0]?.name });
    await showCard(pool, { wait, change, deps });
    return { stage: 'synced' };
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not record a sync before a hand-off', { sessionId: session?.id, err: err.message });
    return null;
  }
}

/**
 * Before a paid fix turn: a change on its way past a check that is not its
 * own (synced, or its fix just in), failing the same checks again, needs no
 * turn to say so. Resolves { why } to hand it on (runChecksFix's handOff with
 * cause not_change), or null for a turn as before. Never throws.
 */
async function carriesOn(pool, { app, sessionId, failing = [], broken = [] } = {}) {
  try {
    if (Array.isArray(broken) && broken.length) return null;
    const wait = await waitOf(pool, sessionId);
    if (!wait || wait.ended_at || !['synced', 'rechecking'].includes(wait.stage)) return null;
    const change = await changeRow(pool, sessionId);
    if (!change || (app && Number(change.app_id) !== Number(app.id))) return null;
    const tests = identifyTests(change.test_results, failing);
    if (!sameTests(tests, wait.tests)) return null;
    return {
      why: wait.stage === 'synced'
        ? 'The same check still fails once it is up to date with main: it fails without the change too.'
        : 'The same check still fails with its fix in.',
    };
  } catch {
    return null;
  }
}

/**
 * Steps 2 and 4, from runChecksFix's hand-off of a red check its fix turn
 * found is not the change's, once the sync before it (step 1) did not happen
 * (`syncWhy`). Resolves
 *   { carriedOn: true, acted }     a fix is on its way: nobody is asked yet
 *   { person: true, text, why }    a person takes it: `text` is the line for the change
 *   null                           not this module's: hand over as before
 * Never throws.
 */
async function onNotChange(pool, config, { app, session, head, failing = [], runId = null, syncWhy = null, deps = {} } = {}) {
  void config;
  try {
    const platform = await isPlatformApp(pool, app, deps);
    const change = platform ? await changeRow(pool, session.id) : null;
    if (platform && !change) return null;
    const ownFix = change ? await ownFixOf(pool, change) : null;
    if (ownFix) {
      // A fix whose own checks fail on something else cannot go in: its
      // waiting changes are told by the sweep, and it is handed over as before.
      await endFlake(pool, ownFix, 'failed', 'its own checks failed on something that is not the fix', { deps });
    }
    const wait = change ? await waitOf(pool, change.id) : null;
    const live = wait && !wait.ended_at ? wait : null;
    const flakes = live ? await flakesOf(pool, live.flake_ids) : [];
    const tests = change ? identifyTests(change.test_results, failing) : [];
    const decided = nextStep({ platform, ownFix: !!ownFix, wait: live, tests, flakes });
    if (decided.do === 'as_today') return null;
    const issueNumber = Array.isArray(change.linked_issues) ? Number(change.linked_issues[0]) || null : null;
    if (decided.do === 'wait') {
      await pool.query('UPDATE homeroom_bot_flake_waits SET head_sha = $2, updated_at = NOW() WHERE session_id = $1',
        [change.id, String(head || '').toLowerCase() || null]);
      return { carriedOn: true, acted: 'checks_flake_waiting' };
    }
    if (decided.do === 'person') {
      const base = live || await saveWait(pool, {
        sessionId: change.id, appId: change.app_id, issueNumber, stage: 'fixing', synced: false, flakeIds: [], tests, head,
      });
      const text = await toPerson(pool, { change, wait: base, why: decided.why, runId, failingCount: failing.length, fromHandOff: true, deps });
      return { person: true, text, why: decided.why };
    }
    // Step 2: a fix for each test, found or filed on Homeroom's board, which
    // the bot must be building on: else nobody would fix it, and a person
    // takes it now, as before.
    const board = await platformBoard(pool, deps);
    const settings = await botModule(deps).readSettings(pool).catch(() => null);
    const notLive = !board || !settings || settings.mode === 'off' || !liveModule(deps).isLiveFor(settings, board);
    if (notLive) {
      const base = await saveWait(pool, {
        sessionId: change.id, appId: change.app_id, issueNumber, stage: 'fixing', synced: !!live?.synced, flakeIds: [], tests, head,
      });
      const why = board ? 'not_live' : 'no_board';
      const text = await toPerson(pool, { change, wait: base, why, runId, failingCount: failing.length, fromHandOff: true, deps });
      return { person: true, text, why };
    }
    const bot = deps.bot || await dmModule(deps).botAccount(pool);
    const fixes = [];
    for (const test of decided.tests) {
      // eslint-disable-next-line no-await-in-loop
      const got = await fixFor(pool, { board, test, bot, deps });
      if (got.flake) fixes.push({ ...got, test });
    }
    const saved = await saveWait(pool, {
      sessionId: change.id, appId: change.app_id, issueNumber, stage: 'fixing', synced: !!live?.synced,
      flakeIds: fixes.map((f) => f.flake.id), tests, head,
    });
    for (const f of fixes) {
      // eslint-disable-next-line no-await-in-loop
      await recordStep(pool, {
        appId: change.app_id, sessionId: change.id, outcome: f.fresh ? (f.flake.filed ? 'filed' : 'found') : 'joined',
        runId, issueNumber: f.flake.issue_number, test: f.test.name,
      });
    }
    // Into the build lane while there is room, else waiting its turn.
    let room = MAX_IN_FLIGHT - await inFlight(pool);
    for (const f of fixes) {
      if (f.flake.state !== 'waiting' || room <= 0) continue;
      // eslint-disable-next-line no-await-in-loop
      f.flake = await startBuilding(pool, f.flake, { deps });
      room -= 1;
      // eslint-disable-next-line no-await-in-loop
      await recordStep(pool, { appId: change.app_id, sessionId: change.id, outcome: 'building', runId, issueNumber: f.flake.issue_number });
    }
    await showCard(pool, { wait: saved, change, syncWhy, deps });
    const fresh = await flakesOf(pool, saved.flake_ids);
    await noteOnChange(pool, { change, kind: 'checks_flake', text: fixingText({ flakes: fresh }), runId, deps });
    log.info('homeroom-bot-flaky', 'A change waits on a fix for a check that is not its own', {
      sessionId: change.id, fixes: fresh.map((f) => Number(f.issue_number)),
    });
    return { carriedOn: true, acted: fixes.some((f) => f.fresh && f.flake.filed) ? 'checks_flake_filed' : 'checks_flake_found' };
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not work past a check that is not the change\'s; handing over as before', {
      sessionId: session?.id, err: err.message,
    });
    return null;
  }
}

/**
 * Its checks passed (homeroom-bot-dm.js tellReady, or the sweep): a change
 * that was on the ladder is done with it, and its card says so, quietly; the
 * ready card is the news. Never throws.
 */
async function noteGreen(pool, sessionId, { deps = {} } = {}) {
  try {
    const wait = await waitOf(pool, sessionId);
    if (!wait || wait.ended_at) return false;
    const ended = await setStage(pool, sessionId, 'green', { end: true });
    const change = await changeRow(pool, sessionId);
    if (change) await showCard(pool, { wait: ended, change, deps });
    await recordStep(pool, { appId: wait.app_id, sessionId, outcome: 'green' });
    log.info('homeroom-bot-flaky', 'A change past a check that was not its own passes now', { sessionId });
    return true;
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not mark a change green', { sessionId, err: err.message });
    return false;
  }
}

async function endFlake(pool, flake, state, why, { mergedSessionId = null } = {}) {
  const { rows: [row] } = await pool.query(
    `UPDATE homeroom_bot_flake_fixes
        SET state = $2, why = COALESCE($3, why), merged_session_id = COALESCE($4, merged_session_id),
            updated_at = NOW(), ended_at = NOW()
      WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [Number(flake.id), state, why ? clip(why, 300) : null, mergedSessionId],
  );
  return row || null;
}

/** Run a waiting change's checks again with its fixes in (step 3). */
async function recheck(pool, config, { wait, deps = {} }) {
  const change = await changeRow(pool, wait.session_id);
  if (!change || change.status !== 'promoted') {
    await setStage(pool, wait.session_id, wait.stage, { end: true });
    return 'gone';
  }
  const head = String(change.checks_commit_sha || change.reviewed_head_sha || '').toLowerCase();
  const fcs = deps.fixedCheckSync || require('./fixed-check-sync');
  const keys = [`homeroom_bot:flake:${(wait.flake_ids || []).map(Number).join('-')}`];
  let how = 'synced';
  const synced = head
    ? await fcs.syncOne({ config, pool, candidate: { id: Number(change.id), head, keys, trigger: 'bot_fix' }, wait: false })
      .catch(() => ({ synced: false, why: 'threw' }))
    : { synced: false, why: 'no_verdict' };
  if (!synced.synced && !synced.requested) {
    // It cannot take main (level, a conflict): its checks run again as they are.
    how = 'rechecked';
    const full = (await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [Number(change.id)],
    )).rows[0];
    const recovery = deps.stagingRecovery || require('./staging-recovery');
    await recovery.recheckSessionChecks({ config, pool, session: full, reason: 'manual-recheck' });
  }
  const moved = await setStage(pool, change.id, 'rechecking', { rechecked: true, head });
  await recordStep(pool, { appId: change.app_id, sessionId: change.id, outcome: 'rechecking', why: how });
  await showCard(pool, { wait: moved, change, deps });
  return how;
}

/** Every change waiting on `flakeIds` whose fixes are all in: their checks run again. */
async function recheckWaiters(pool, config, flakeIds, { deps = {} } = {}) {
  const { rows: waits } = await pool.query(
    `SELECT w.* FROM homeroom_bot_flake_waits w
      WHERE w.ended_at IS NULL AND w.stage = 'fixing' AND w.flake_ids && $1::int[]
        AND NOT EXISTS (SELECT 1 FROM homeroom_bot_flake_fixes f
                         WHERE f.id = ANY(w.flake_ids) AND f.state <> 'merged')`,
    [flakeIds.map(Number)],
  );
  const out = [];
  for (const wait of waits) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push({ sessionId: Number(wait.session_id), how: await recheck(pool, config, { wait, deps }) });
    } catch (err) {
      log.warn('homeroom-bot-flaky', 'Could not run a waiting change\'s checks again', { sessionId: wait.session_id, err: err.message });
    }
  }
  return out;
}

/**
 * A change was merged (homeroom-bot.js noteRequestMerged, for the bot's own;
 * the sweep for anybody's): every fix it was for is in, and the changes that
 * waited on it run their checks again. Never throws; resolves what it rechecked.
 */
async function fixMerged(pool, config, { appId, issues = [], sessionId = null, deps = {} } = {}) {
  try {
    const numbers = (Array.isArray(issues) ? issues : []).map(Number).filter((n) => n > 0);
    if (!numbers.length) return [];
    const { rows: flakes } = await pool.query(
      `SELECT * FROM homeroom_bot_flake_fixes WHERE app_id = $1 AND issue_number = ANY($2::int[]) AND ended_at IS NULL`,
      [Number(appId), numbers],
    );
    const merged = [];
    for (const f of flakes) {
      // eslint-disable-next-line no-await-in-loop
      const done = await endFlake(pool, f, 'merged', null, { mergedSessionId: sessionId ? Number(sessionId) : null });
      if (done) merged.push(done);
    }
    if (!merged.length) return [];
    log.info('homeroom-bot-flaky', 'A fix for a flaky check merged', { appId, issues: merged.map((f) => f.issue_number) });
    const out = await recheckWaiters(pool, config, merged.map((f) => f.id), { deps });
    // A slot in the lane freed: the next fix waiting its turn starts.
    await startWaiting(pool, { deps });
    return out;
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'Could not follow a merged fix', { appId, err: err.message });
    return [];
  }
}

async function startWaiting(pool, { deps = {} } = {}) {
  let room = MAX_IN_FLIGHT - await inFlight(pool);
  if (room <= 0) return 0;
  const { rows } = await pool.query(
    `SELECT * FROM homeroom_bot_flake_fixes WHERE state = 'waiting' AND ended_at IS NULL ORDER BY id LIMIT $1`, [room]);
  let started = 0;
  for (const f of rows) {
    if (room <= 0) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      await startBuilding(pool, f, { deps });
      started += 1;
      room -= 1;
    } catch (err) {
      log.warn('homeroom-bot-flaky', 'Could not start a waiting fix', { flakeId: f.id, err: err.message });
    }
  }
  return started;
}

// What ended a fix, as the sweep reads it: merged by anybody, its request
// closed, the bot's verdict on it a person or nothing to build, or too long.
const SWEEP_FLAKES_SQL = `
  SELECT f.*,
         (SELECT cs.id FROM chat_sessions cs
           WHERE cs.app_id = f.app_id AND f.issue_number = ANY(cs.linked_issues)
             AND cs.status = 'merged' AND cs.merged_at >= f.created_at
           ORDER BY cs.merged_at DESC LIMIT 1) AS merged_id,
         (SELECT r.state FROM requests r WHERE r.app_id = f.app_id AND r.number = f.issue_number) AS request_state,
         (SELECT r.verdict FROM homeroom_bot_runs r
           WHERE r.app_id = f.app_id AND r.issue_number = f.issue_number AND r.mode = 'live' AND r.created_at >= f.created_at
           ORDER BY r.id DESC LIMIT 1) AS verdict,
         f.created_at < NOW() - make_interval(days => $1) AS too_old
    FROM homeroom_bot_flake_fixes f
   WHERE f.ended_at IS NULL`;

/**
 * The bot's five-minute sweep (homeroom-bot.js sweep): fixes merged by
 * anybody or ended, changes waiting on them, the lane's room, and waits that
 * went quiet. Resolves counts. Never throws.
 */
async function sweep(pool, config, { deps = {} } = {}) {
  const out = { merged: 0, ended: 0, started: 0, green: 0, person: 0 };
  try {
    const { rows: flakes } = await pool.query(SWEEP_FLAKES_SQL, [WAIT_DAYS]);
    for (const f of flakes) {
      try {
        if (f.merged_id) {
          // eslint-disable-next-line no-await-in-loop
          const rechecked = await fixMerged(pool, config, { appId: f.app_id, issues: [f.issue_number], sessionId: f.merged_id, deps });
          out.merged += 1;
          void rechecked;
          continue;
        }
        const ended = f.request_state === 'closed' ? ['closed', 'its request was closed']
          : ['person', 'empty'].includes(f.verdict) ? ['failed', `Homeroom bot's look at it ended with "${f.verdict}"`]
            : f.too_old ? ['expired', `not fixed within ${WAIT_DAYS} days`] : null;
        if (ended) {
          // eslint-disable-next-line no-await-in-loop
          await endFlake(pool, f, ended[0], ended[1]);
          out.ended += 1;
        }
      } catch (err) {
        log.warn('homeroom-bot-flaky', 'Could not sweep a fix', { flakeId: f.id, err: err.message });
      }
    }
    out.started = await startWaiting(pool, { deps });
    // The changes still on the ladder.
    const { rows: waits } = await pool.query(
      `SELECT w.*, cs.status AS change_status, cs.check_state, cs.checks_commit_sha, cs.checks_checked_at, cs.reviewed_head_sha,
              w.started_at < NOW() - make_interval(days => $1) AS too_old,
              EXISTS (SELECT 1 FROM homeroom_bot_flake_fixes f
                       WHERE f.id = ANY(w.flake_ids) AND f.state IN ('failed', 'closed', 'expired')) AS fix_ended_badly,
              (SELECT f.state FROM homeroom_bot_flake_fixes f
                WHERE f.id = ANY(w.flake_ids) AND f.state IN ('failed', 'closed', 'expired') ORDER BY f.id LIMIT 1) AS bad_state,
              cardinality(w.flake_ids) > 0 AND NOT EXISTS (SELECT 1 FROM homeroom_bot_flake_fixes f
                WHERE f.id = ANY(w.flake_ids) AND f.state <> 'merged') AS all_merged
         FROM homeroom_bot_flake_waits w JOIN chat_sessions cs ON cs.id = w.session_id
        WHERE w.ended_at IS NULL`,
      [WAIT_DAYS],
    );
    for (const w of waits) {
      try {
        if (w.change_status !== 'promoted') {
          // eslint-disable-next-line no-await-in-loop
          await setStage(pool, w.session_id, w.stage, { end: true });
          continue;
        }
        const onHead = w.checks_commit_sha && w.reviewed_head_sha
          && String(w.checks_commit_sha).toLowerCase() === String(w.reviewed_head_sha).toLowerCase();
        if (onHead && ['passing', 'skipped'].includes(w.check_state)) {
          // eslint-disable-next-line no-await-in-loop
          if (await noteGreen(pool, w.session_id, { deps })) out.green += 1;
          continue;
        }
        if (w.stage === 'fixing' && w.all_merged) {
          // Its fixes are in and nothing ran its checks again (a recheck
          // that failed before): it runs them now.
          // eslint-disable-next-line no-await-in-loop
          await recheck(pool, config, { wait: w, deps });
          continue;
        }
        let why = null;
        if (w.fix_ended_badly) why = `fix_${w.bad_state}`;
        else if (w.too_old) why = 'too_long';
        else if (w.stage === 'rechecking' && w.check_state === 'failing' && w.rechecked_at && w.checks_checked_at
          && new Date(w.checks_checked_at) > new Date(w.rechecked_at)
          && String(w.checks_commit_sha || '').toLowerCase() === String(w.head_sha || '').toLowerCase()) {
          // Run again on the same head (no sync), and still red: the bot will
          // not look at that head again, so it is said here.
          why = 'still_fails';
        }
        if (why) {
          // eslint-disable-next-line no-await-in-loop
          const change = await changeRow(pool, w.session_id);
          // eslint-disable-next-line no-await-in-loop
          if (change) await toPerson(pool, { change, wait: w, why, deps });
          out.person += 1;
        }
      } catch (err) {
        log.warn('homeroom-bot-flaky', 'Could not sweep a waiting change', { sessionId: w.session_id, err: err.message });
      }
    }
  } catch (err) {
    log.warn('homeroom-bot-flaky', 'The flaky-check sweep failed', { err: err.message });
  }
  return out.merged || out.ended || out.started || out.green || out.person ? out : null;
}

module.exports = {
  MAX_IN_FLIGHT,
  WAIT_DAYS,
  MAX_TESTS,
  INCIDENT_KIND,
  FIX_REASON,
  TITLE_PREFIX,
  testKey,
  errorLine,
  identifyTests,
  sameTests,
  nextStep,
  personWhy,
  flakeTitle,
  flakeMarker,
  flakeBody,
  cardFor,
  fixingText,
  personText,
  exemptFromAppCap,
  onSynced,
  carriesOn,
  onNotChange,
  noteGreen,
  fixMerged,
  recheckWaiters,
  startWaiting,
  sweep,
  waitOf,
  flakesOf,
};
