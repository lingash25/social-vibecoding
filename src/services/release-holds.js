'use strict';

// Risky changes ask an admin (#6643).
//
// A change that carries risk is not refused: it is HELD. Its card says why,
// the platform's full admins are told by a bell row and an email, and one of
// them has to vote yes before it goes live. Their no closes the change and
// the request it was built for. With no answer it stays held and open: it
// never goes live on a timer and never closes on one.
//
// What trips a hold is RULES below, each a plain read of the change's diff
// when its checks settle (services/visuals.js), on the same compare the
// Content rules review reads. Two kinds of change are left out. The
// platform's own app: these are rules for the apps people build on Homeroom,
// and its own changes already answer to the platform's variables gate and
// its admins. And a project's first version, which goes live without a vote
// for the person who just described it (evaluate() says why).
//
// One rule tells without holding: `unread`, a change too large to read whole
// or whose diff could not be loaded. It used to hold, and nearly every time
// the reason was a rebuilt bundle committed beside a few lines of source, so
// an admin was put in front of changes that carried nothing. The admins are
// still told, once, by the same bell row and mail, which say it is not held;
// the change goes live on its votes and checks like any other. Such a change
// has a 'notice' row, which no gate reads. When a rule that holds trips on
// the same change, it is held as before and `unread` is one of its reasons.
//
// A hold is a row in release_holds. What an admin decided is NOT a column:
// the gate reads pr_votes, like every other tally, so an approval a new
// version cleared is not remembered as given.
//
//   - held            a 'waiting' row exists for the change
//   - approved        a full admin other than the author has a yes that
//                     still counts (the approval epoch, pr-vote-revision.js)
//   - needs another   the author is a full admin: their own yes never counts
//
// The merge gate (routes/votes.js evaluateMergeGate), the merge queue's line
// (src/workflow/merge-queue/facts.ts) and the merge claim
// (src/workflow/rules/merge-claim.ts) all read the same two SQL fragments
// from here, so the three cannot disagree about what "held" means.

const log = require('./logger');
const { currentVotePredicateSql } = require('./pr-vote-revision');
const { PRODUCTION_ORIGIN } = require('./cli-auth-constants');

const KIND = 'release_hold';
const CLOSE_REASON = 'admin-declined';
const DIFF_CHAR_BUDGET = 120000;
const NOTE_MAX = 1000;
// What a bell row's detail starts with when the change is not held: the
// admins are only told (frontend notifications.js and the push read it).
const NOTICE_DETAIL = 'notice:';

// The gated capabilities an app declares in dapp.json's `permissions`
// (services/app-permissions.js), as they are spelled there.
const { GATED_NAMES } = require('./app-permissions');
const CAPABILITY = new RegExp(`"(${GATED_NAMES.join('|')})"`);
// A column that holds a person's contact or personal details, by the words in
// its name ("email", "contact_email", "phone_number", "date_of_birth",
// "home_address"). Saying WHOSE a row is does not count: user_id, username
// and usernode_pubkey are what the platform hands every app about its
// signed-in person, and nearly every table carries one of them.
const PERSON_WORD = /^(e?mail|phone|mobile|birth(day|date)?|dob|address|street|postcode|zip)$/;
const PERSON_PAIR = /(^|_)((full|first|last|real|legal)_name|date_of_birth|postal_code|zip_code)(_|$)/;
function isPersonColumn(name) {
  const n = String(name || '').toLowerCase();
  return PERSON_PAIR.test(n) || n.split('_').some((w) => PERSON_WORD.test(w));
}

// The columns of the tables a file's added lines create: the first word of
// each top-level piece between a CREATE TABLE's own brackets. A person word
// anywhere else in the file (a query, a comment, a route, the code after the
// statement) is not a column of a new table, so it holds nothing. A table
// whose closing bracket is not among the added lines is read to the end of
// what was added, or TABLE_BODY_LINES, whichever comes first.
const TABLE_BODY_LINES = 200;
function newTableColumns(added) {
  const columns = [];
  for (let i = 0; i < added.length; i += 1) {
    const start = /\bCREATE\s+TABLE\b/i.exec(added[i]);
    if (!start) continue;
    let depth = 0;
    let piece = '';
    let done = false;
    const flush = () => {
      const word = /^\s*["`\[]?([A-Za-z_][A-Za-z0-9_]*)/.exec(piece);
      if (word) columns.push(word[1]);
      piece = '';
    };
    let j = i;
    for (; j < added.length && j - i < TABLE_BODY_LINES && !done; j += 1) {
      const text = j === i ? added[j].slice(start.index + start[0].length) : added[j];
      if (j > i && /\bCREATE\s+TABLE\b/i.test(text)) break;
      for (const ch of text) {
        if (ch === '(') { depth += 1; if (depth === 1) continue; }
        if (ch === ')') { depth -= 1; if (depth === 0) { flush(); done = true; break; } }
        if (depth === 1 && ch === ',') flush();
        else if (depth >= 1) piece += ch;
      }
      if (depth === 1) flush();
    }
    i = Math.max(i, j - 1);
  }
  return columns;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

// The rules, in the order every surface lists them. `key` is what the row
// stores and what the catalogs word ('changes:hold.rule.<key>').
const RULES = Object.freeze([
  Object.freeze({
    key: 'wallet',
    words: 'It lets the app send tokens',
    read: (c) => c.files.some((f) => !TEST_FILE.test(f.path) && f.added.some((l) => /\bsendTransaction\s*\(/.test(l))),
  }),
  Object.freeze({
    key: 'people',
    words: 'It starts keeping data about people',
    read: (c) => c.files.some((f) => !TEST_FILE.test(f.path) && newTableColumns(f.added).some(isPersonColumn)),
  }),
  Object.freeze({
    key: 'secret',
    words: 'It adds a private key for an outside service',
    read: (c) => c.files.some((f) => isManifest(f.path) && f.added.some((l) => /"private"\s*:\s*true/.test(l))),
  }),
  Object.freeze({
    key: 'capability',
    words: 'It asks for a device capability such as location',
    read: (c) => c.files.some((f) => isManifest(f.path) && f.added.some((l) => CAPABILITY.test(l))),
  }),
  Object.freeze({
    key: 'script',
    words: 'It loads a script from another site',
    read: (c) => c.files.some((f) => !TEST_FILE.test(f.path)
      && f.added.some((l) => /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i.test(l))),
  }),
  Object.freeze({
    key: 'content',
    words: 'The Content rules check flagged it',
    read: (c) => !!c.contentFlagged,
  }),
  // The rules above only mean something on a change that was read whole. One
  // too large for the reader, or whose diff could not be loaded, says so to
  // the admins and holds nothing (`holds: false`): what was read of it still
  // trips the rules above, and the part past the cut-off is theirs to look
  // at if they choose.
  Object.freeze({
    key: 'unread',
    words: 'It could not be read in full',
    holds: false,
    read: (c) => !!c.unread,
  }),
]);
const RULE_KEYS = Object.freeze(RULES.map((r) => r.key));
const RULE_BY_KEY = new Map(RULES.map((r) => [r.key, r]));

/** Whether any of these rules holds the change, rather than only telling the admins. */
function holds(list) {
  return cleanRules(list).some((k) => RULE_BY_KEY.get(k).holds !== false);
}

function isManifest(path) { return /(^|\/)dapp\.json$/.test(path); }

// A unified diff as [{ path, added: [line, ...] }]: the lines a change ADDS,
// per file. A rule never reads a removed or unchanged line, so deleting a
// wallet send does not hold the change that deletes it.
function addedByFile(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) { current = { path: head[2], added: [] }; files.push(current); continue; }
    if (!current || line.startsWith('+++')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
  }
  return files;
}

/** Pure: the keys of the rules this diff trips, in RULES' order. */
function tripped({ diff = '', contentFlagged = false, unread = false } = {}) {
  const facts = { files: addedByFile(diff), contentFlagged: !!contentFlagged, unread: !!unread };
  return RULES.filter((r) => { try { return r.read(facts); } catch { return false; } }).map((r) => r.key);
}

function cleanRules(list) {
  const seen = new Set((Array.isArray(list) ? list : []).map(String));
  return RULE_KEYS.filter((k) => seen.has(k));
}

/** The rules in plain English, for the server's own sentences and the mail. */
function ruleWords(list) {
  return cleanRules(list).map((k) => RULE_BY_KEY.get(k).words);
}

// ── What the merge path reads ───────────────────────────────────────────

/** SQL: the change (alias of chat_sessions) has a hold waiting. */
function heldSql(cs = 'cs') {
  return `EXISTS (SELECT 1 FROM release_holds rh WHERE rh.session_id = ${cs}.id AND rh.status = 'waiting')`;
}

/**
 * SQL: a full admin who is NOT the change's author has a yes that still
 * counts. The author's own yes never lifts their own hold.
 */
function approvedSql(cs = 'cs') {
  return `EXISTS (SELECT 1 FROM pr_votes rhv JOIN users rhu ON rhu.id = rhv.user_id
           WHERE rhv.session_id = ${cs}.id AND rhv.vote = 'yes' AND ${currentVotePredicateSql('rhv', cs)}
             AND rhu.is_admin = TRUE AND rhu.admin_readonly = FALSE
             AND rhv.user_id IS DISTINCT FROM ${cs}.user_id)`;
}

// Whether the author is a full admin, so the card can say "Needs another
// admin" instead of asking them for a vote that would not count.
function authorIsAdminSql(cs = 'cs') {
  return `EXISTS (SELECT 1 FROM users rha WHERE rha.id = ${cs}.user_id
           AND rha.is_admin = TRUE AND rha.admin_readonly = FALSE)`;
}

/** The gate's read for one change: { held, approved, rules, ... } or null. */
async function gateFor(pool, sessionId) {
  const { rows: [r] } = await pool.query(
    `SELECT rh.id, rh.rules, rh.created_at, rh.notified_at,
            ${approvedSql('cs')} AS approved, ${authorIsAdminSql('cs')} AS author_admin
       FROM release_holds rh JOIN chat_sessions cs ON cs.id = rh.session_id
      WHERE rh.session_id = $1 AND rh.status = 'waiting'`, [sessionId]);
  // Only a row that is a hold: an id and its rules. Anything else is no hold.
  if (!r || r.id == null || !Array.isArray(r.rules)) return null;
  return shape(r);
}

function shape(r) {
  return {
    id: Number(r.id),
    rules: cleanRules(r.rules),
    askedAt: r.notified_at ? new Date(r.notified_at).toISOString() : null,
    heldAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    approved: !!r.approved,
    needsAnotherAdmin: !!r.author_admin,
  };
}

/**
 * The card's block for many changes at once: Map(sessionId -> hold), only
 * for the ones with a hold waiting. One query per panel, not per row.
 */
async function forSessions(pool, sessionIds) {
  const ids = [...new Set((sessionIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { rows } = await pool.query(
      `SELECT rh.session_id, rh.id, rh.rules, rh.created_at, rh.notified_at,
              ${approvedSql('cs')} AS approved, ${authorIsAdminSql('cs')} AS author_admin
         FROM release_holds rh JOIN chat_sessions cs ON cs.id = rh.session_id
        WHERE rh.session_id = ANY($1::int[]) AND rh.status = 'waiting'`, [ids]);
    for (const r of rows) out.set(Number(r.session_id), shape(r));
  } catch (err) {
    // A panel never fails on this read (a build whose migration has not run).
    log.debug('release-holds', 'Could not read holds for a panel', { err: err.message });
  }
  return out;
}

// ── Opening, updating and ending a hold ─────────────────────────────────

const evaluated = new Map();
const EVALUATED_MAX = 500;

/**
 * Read one head against the rules and bring the change's hold in line:
 * open one, replace its reasons, or end it as fixed. Called when the checks
 * settle, with the Content rules row that run produced. Never throws.
 *
 * deps are injectable for tests: { github, notify }.
 */
async function evaluate({
  config = null, pool, session, app, repoOwner, repoName, commitHash,
  contentRow = null, baseRef = 'main', deps = {},
} = {}) {
  try {
    if (!pool || !session?.id || !app?.id || !commitHash) return null;
    if (app.self_hosted) return null;
    if (!repoOwner || !repoName) return null;
    const github = deps.github || require('./github');
    if (typeof github.isEnabled === 'function' && !github.isEnabled()) return null;
    // A project's first version goes live without a vote, for the person who
    // just described it (services/first-version-rule.js), and nearly every
    // one of them creates a table with its people in it. Holding it would put
    // an admin between every new project and its first screen, so the rules
    // start with the changes that come after it.
    const isFirstVersion = deps.isFirstVersion || require('./first-version-rule').isFirstVersion;
    if (await isFirstVersion(pool, session.id)) return null;

    const contentFlagged = !!contentRow && contentRow.status === 'fail';
    const key = `${session.id}:${String(commitHash).toLowerCase()}:${contentFlagged ? 1 : 0}`;
    let rules = evaluated.get(key);
    if (!rules) {
      let diff = '';
      let unread = false;
      let failed = false;
      try {
        const d = await github.getProposalDiff(repoOwner, repoName, `${baseRef}...${commitHash}`, DIFF_CHAR_BUDGET);
        diff = String(d?.diff || '');
        // Cut off at the budget, or a file list the compare did not finish:
        // what was read still counts, and the admins are told about the rest.
        unread = !!d?.truncated || d?.filesComplete === false;
      } catch (err) {
        // A change nobody could read is not passed over in silence: the
        // admins are told, like one cut off at the budget, and the next run
        // that reads it whole says what it holds.
        log.warn('release-holds', 'Could not load the diff, so the admins are told', { sessionId: session.id, err: err.message });
        unread = true;
        failed = true;
      }
      rules = tripped({ diff, contentFlagged, unread });
      // A failed read is not remembered: the next run asks again.
      if (!failed) {
        evaluated.set(key, rules);
        if (evaluated.size > EVALUATED_MAX) evaluated.delete(evaluated.keys().next().value);
      }
    }

    const outcome = await apply(pool, { sessionId: session.id, appId: app.id, commitHash, rules });
    if (outcome.state === 'held' || outcome.state === 'notice') {
      await (deps.notify || notifyIfDue)({ config, pool, sessionId: session.id });
    }
    return outcome;
  } catch (err) {
    log.warn('release-holds', 'Reading a change for holds failed', { sessionId: session?.id, err: err.message });
    return null;
  }
}

async function apply(pool, { sessionId, appId, commitHash, rules }) {
  const head = String(commitHash).toLowerCase();
  if (!holds(rules)) {
    const { rowCount } = await pool.query(
      `UPDATE release_holds SET status = 'fixed', decided_at = NOW()
        WHERE session_id = $1 AND status = 'waiting'`, [sessionId]);
    if (rowCount) log.info('release-holds', 'A new version trips no rule that holds, so the hold ended', { sessionId });
    if (!rules.length) {
      await endNotice(pool, sessionId);
      return { state: rowCount ? 'fixed' : 'clear', rules: [] };
    }
    // Only rules that tell: one 'notice' row per change, which no gate
    // reads. A later version keeps the row, so the admins are told once.
    const { rows: [notice] } = await pool.query(
      `INSERT INTO release_holds (app_id, session_id, head_sha, rules, status)
       VALUES ($1, $2, $3, $4::text[], 'notice')
       ON CONFLICT (session_id) WHERE status = 'notice'
       DO UPDATE SET head_sha = EXCLUDED.head_sha, rules = EXCLUDED.rules
       RETURNING id, (xmax = 0) AS opened`, [appId, sessionId, head, rules]);
    if (notice?.opened) log.info('release-holds', 'Admins will be told about a change, which is not held', { sessionId, rules });
    return { state: 'notice', rules, id: notice ? Number(notice.id) : null, opened: !!notice?.opened };
  }
  // Held now: the hold's own tell says everything, so a notice nobody has
  // been sent yet is not sent after it.
  await endNotice(pool, sessionId);
  const { rows: [row] } = await pool.query(
    `INSERT INTO release_holds (app_id, session_id, head_sha, rules)
     VALUES ($1, $2, $3, $4::text[])
     ON CONFLICT (session_id) WHERE status = 'waiting'
     DO UPDATE SET head_sha = EXCLUDED.head_sha, rules = EXCLUDED.rules
     RETURNING id, (xmax = 0) AS opened`, [appId, sessionId, head, rules]);
  if (row?.opened) log.info('release-holds', 'Change held for an admin', { sessionId, rules });
  return { state: 'held', rules, id: row ? Number(row.id) : null, opened: !!row?.opened };
}

// A 'notice' row stands only while the change's newest version is one the
// admins are merely told about. Once a version is read whole, or is held,
// the row ends, so the clock never tells them about a version that is gone.
async function endNotice(pool, sessionId) {
  await pool.query(
    `UPDATE release_holds SET status = 'fixed', decided_at = NOW()
      WHERE session_id = $1 AND status = 'notice'`, [sessionId]);
}

// ── Telling the admins ──────────────────────────────────────────────────

/**
 * Tell the full admins about a hold, or about a change they are only told
 * of, once, and only when the change is up for a vote: a change still being
 * worked on asks nobody. Called when the checks settle and again when the
 * change is proposed. A change with both rows is told of its hold. Never
 * throws.
 */
async function notifyIfDue({ config = null, pool, sessionId, deps = {} } = {}) {
  try {
    const { rows: [hold] } = await pool.query(
      `UPDATE release_holds rh SET notified_at = NOW()
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE rh.id = (SELECT due.id FROM release_holds due
                        WHERE due.session_id = $1 AND due.status IN ('waiting', 'notice') AND due.notified_at IS NULL
                        ORDER BY (due.status = 'waiting') DESC, due.id LIMIT 1)
          AND rh.notified_at IS NULL
          AND cs.id = rh.session_id AND cs.status = 'promoted'
      RETURNING rh.id, rh.rules, rh.status, cs.id AS session_id, cs.user_id AS author_id, cs.app_id,
                a.slug AS app_slug, a.name AS app_name,
                COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''), 'A change') AS title`,
      [sessionId]);
    if (!hold) return { notified: 0 };
    const rules = cleanRules(hold.rules);
    // A row that only tells says so in the bell row's detail and the mail's
    // `held`, which is what the words of both are chosen by.
    const held = hold.status !== 'notice';

    // Full admins, never the author: their own yes would not count.
    const { rows: created } = await pool.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, app_id, session_id, detail)
       SELECT admin.id, $2, '${KIND}', $3, $1, $4
         FROM users admin
        WHERE admin.is_admin = TRUE AND admin.admin_readonly = FALSE
          AND admin.anonymised_at IS NULL
          AND admin.id IS DISTINCT FROM $2
       RETURNING id, user_id`,
      [hold.session_id, hold.author_id, hold.app_id, `${held ? '' : NOTICE_DETAIL}${rules.join(',')}`]);
    const notifications = deps.notifications || require('./notifications');
    await Promise.all(created.map((row) => notifications.hydrateAndPush(pool, row)))
      .catch((err) => log.warn('release-holds', 'Pushing the hold to the bell failed', { sessionId, err: err.message }));

    await mailAdmins({ config, pool, hold, rules, held, adminIds: created.map((r) => r.user_id), deps });
    log.info('release-holds', held ? 'Admins asked to approve a held change' : 'Admins told about a change that is not held',
      { sessionId, admins: created.length });
    return { notified: created.length };
  } catch (err) {
    log.warn('release-holds', 'Could not tell the admins about a hold', { sessionId, err: err.message });
    return { notified: 0 };
  }
}

function changeUrl(slug, sessionId) {
  return `${PRODUCTION_ORIGIN}/#app/${encodeURIComponent(slug)}/dev/proposals/${Number(sessionId)}`;
}

async function mailAdmins({ config, pool, hold, rules, held = true, adminIds, deps = {} }) {
  if (!adminIds.length) return;
  const send = deps.sendMail || ((cfg, message) => require('./mail').send(cfg, message));
  const [{ rows: admins }, { rows: [author] }] = await Promise.all([
    pool.query(`SELECT id, email, locale FROM users WHERE id = ANY($1::int[]) AND email IS NOT NULL AND email <> ''`, [adminIds]),
    pool.query('SELECT username FROM users WHERE id = $1', [hold.author_id]),
  ]);
  const payload = {
    kind: KIND,
    appName: hold.app_name || '',
    title: hold.title,
    author: author?.username || '',
    reasons: ruleWords(rules),
    held,
    url: changeUrl(hold.app_slug, hold.session_id),
  };
  await Promise.all(admins.map((admin) => Promise.resolve()
    .then(() => send(config, { ...payload, to: admin.email, locale: admin.locale || undefined }))
    .catch((err) => log.warn('release-holds', 'Hold mail failed', { adminId: admin.id, message: err.message }))));
}

/**
 * The clock's pass (src/workflow/clock/services.ts): every hold whose change
 * is up for a vote and whose admins have not been told yet. This is what
 * tells them about a change that was held while it was still being worked
 * on and proposed afterwards, and what repeats a tell that failed. Each is
 * claimed by notifyIfDue's own UPDATE, so two passes send one.
 */
async function sweep(pool, { config = null, deps = {} } = {}) {
  const cfg = config || require('../config');
  const { rows } = await pool.query(
    `SELECT rh.session_id FROM release_holds rh JOIN chat_sessions cs ON cs.id = rh.session_id
      WHERE rh.status IN ('waiting', 'notice') AND rh.notified_at IS NULL AND cs.status = 'promoted'
      ORDER BY rh.created_at LIMIT 50`);
  let notified = 0;
  for (const r of rows) {
    notified += (await notifyIfDue({ config: cfg, pool, sessionId: Number(r.session_id), deps })).notified ? 1 : 0;
  }
  return { due: rows.length, notified };
}

// ── An admin's vote ─────────────────────────────────────────────────────

/**
 * What a recorded vote does to a held change. Only a FULL admin who is not
 * the author matters here:
 *
 *   yes  the gate reads the vote itself, so nothing is written: the other
 *        admins' bell rows about this hold are simply read.
 *   no   the hold is declined with their sentence, and the change and the
 *        request it was built for are closed.
 *
 * Returns { closed: true } after a decline, else null. Never throws.
 */
async function onVote({ pool, session, user, vote, reason = null, deps = {} } = {}) {
  try {
    if (!session?.id || !user?.id) return null;
    if (Number(user.id) === Number(session.user_id)) return null;
    const { rows: [voter] } = await pool.query(
      `SELECT (is_admin = TRUE AND admin_readonly = FALSE) AS full_admin FROM users WHERE id = $1`, [user.id]);
    if (!voter?.full_admin) return null;

    if (vote === 'yes') {
      const { rows: [hold] } = await pool.query(
        `SELECT id FROM release_holds WHERE session_id = $1 AND status = 'waiting'`, [session.id]);
      if (!hold) return null;
      const { rows } = await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE kind = '${KIND}' AND session_id = $1 AND read_at IS NULL
        RETURNING user_id`, [session.id]);
      tellBells(rows, deps);
      return { approved: true };
    }
    if (vote !== 'no') return null;

    const note = String(reason || '').trim().slice(0, NOTE_MAX) || null;
    const { rows: [hold] } = await pool.query(
      `UPDATE release_holds SET status = 'declined', decided_by = $2, note = $3, decided_at = NOW()
        WHERE session_id = $1 AND status = 'waiting'
      RETURNING id, rules`, [session.id, user.id, note]);
    if (!hold) return null;
    log.info('release-holds', 'An admin declined a held change', { sessionId: session.id, adminId: user.id });

    const lifecycle = deps.lifecycle || require('./session-lifecycle');
    const closed = await lifecycle.archiveSession({
      pool, sessionId: session.id, reason: CLOSE_REASON, from: session.status, username: user.username || null,
    }).catch((err) => {
      log.warn('release-holds', 'Closing the declined change failed', { sessionId: session.id, err: err.message });
      return { archived: false };
    });
    await closeRequests({ pool, session, user, note, deps });
    return { closed: true, archived: !!closed?.archived };
  } catch (err) {
    log.warn('release-holds', 'Applying an admin vote to a hold failed', { sessionId: session?.id, err: err.message });
    return null;
  }
}

function tellBells(rows, deps = {}) {
  const push = deps.pushNotificationToUser || require('./ws').pushNotificationToUser;
  if (typeof push !== 'function') return;
  for (const id of new Set((rows || []).map((r) => Number(r.user_id)))) {
    try { push(id, { type: 'notifications_changed' }); } catch { /* a bell that refreshes late */ }
  }
}

// The requests the change was built for close with it, each with a line
// saying why. One that is already closed, or cannot be closed, is left.
async function closeRequests({ pool, session, user, note, deps = {} }) {
  const numbers = [...new Set((Array.isArray(session.linked_issues) ? session.linked_issues : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!numbers.length) return;
  const repoRef = require('./repo-ref');
  const ref = repoRef.ownerRepo(session.repo_url);
  if (!ref) return;
  const requests = deps.requests || require('./requests');
  const line = `An admin did not approve the change built for this request, so it was closed.${note ? ` Their reason: ${note}` : ''}`;
  for (const number of numbers) {
    try {
      await requests.comment(ref.owner, ref.repo, number, line, { authorLogin: 'homeroom' }).catch(() => {});
      await requests.close(ref.owner, ref.repo, number, { reason: 'not_planned', closedBy: user.id });
    } catch (err) {
      log.warn('release-holds', 'Could not close the request of a declined change', { number, err: err.message });
    }
  }
  void pool;
}

// ── The admin console's lists ───────────────────────────────────────────

const LIST_SQL = `
  SELECT rh.id, rh.session_id, rh.rules, rh.status, rh.note, rh.created_at, rh.decided_at, rh.notified_at,
         a.slug AS app_slug, a.name AS app_name,
         COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''), 'A change') AS title,
         cs.pr_number, cs.status AS session_status, cs.user_id AS author_id,
         author.username AS author, decider.username AS decided_by,
         ${approvedSql('cs')} AS approved, ${authorIsAdminSql('cs')} AS author_admin
    FROM release_holds rh
    JOIN chat_sessions cs ON cs.id = rh.session_id
    JOIN apps a ON a.id = rh.app_id
    LEFT JOIN users author ON author.id = cs.user_id
    LEFT JOIN users decider ON decider.id = rh.decided_by`;

// How a hold reads once it is no longer waiting on anybody.
function outcomeOf(r) {
  if (r.status === 'notice') return 'notice';
  if (r.status === 'declined') return 'declined';
  if (r.status === 'fixed') return 'fixed';
  if (r.session_status === 'merged') return 'approved';
  if (r.session_status === 'promoted' || r.session_status === 'merging') return r.approved ? 'approved' : 'waiting';
  return 'closed';
}

function listRow(r, viewerId) {
  return {
    id: Number(r.id),
    sessionId: Number(r.session_id),
    appSlug: r.app_slug,
    appName: r.app_name,
    title: r.title,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    author: r.author || null,
    rules: cleanRules(r.rules),
    reasons: ruleWords(r.rules),
    outcome: outcomeOf(r),
    note: r.note || null,
    decidedBy: r.decided_by || null,
    heldAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    // The viewer wrote it, so their yes would not count.
    needsAnotherAdmin: viewerId != null && Number(r.author_id) === Number(viewerId),
  };
}

/** { waiting: [...oldest first], history: [...newest first] } for the console. */
async function listForAdmin(pool, { viewerId = null, historyLimit = 100 } = {}) {
  const [waiting, history] = await Promise.all([
    pool.query(
      `${LIST_SQL}
        WHERE rh.status = 'waiting' AND cs.status IN ('promoted', 'merging') AND NOT ${approvedSql('cs')}
        ORDER BY rh.created_at ASC LIMIT 200`),
    pool.query(
      `${LIST_SQL}
        WHERE NOT (rh.status = 'waiting' AND cs.status IN ('promoted', 'merging') AND NOT ${approvedSql('cs')})
          AND NOT (rh.status = 'waiting' AND cs.status NOT IN ('promoted', 'merging', 'merged', 'archived'))
        ORDER BY COALESCE(rh.decided_at, rh.created_at) DESC LIMIT $1`, [Math.max(1, Math.min(500, Number(historyLimit) || 100))]),
  ]);
  return {
    waiting: waiting.rows.map((r) => listRow(r, viewerId)),
    history: history.rows.map((r) => listRow(r, viewerId)),
    rules: RULES.map((r) => ({ key: r.key, words: r.words })),
  };
}

function _resetCache() { evaluated.clear(); }

module.exports = {
  KIND, CLOSE_REASON, NOTICE_DETAIL, RULES, RULE_KEYS,
  addedByFile, tripped, cleanRules, ruleWords, holds,
  heldSql, approvedSql, gateFor, forSessions,
  evaluate, apply, notifyIfDue, sweep, onVote, listForAdmin, changeUrl,
  _resetCache,
};
