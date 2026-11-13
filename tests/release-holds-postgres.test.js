'use strict';

// #6643: a held change against the full schema (src/services/release-holds.js):
// one waiting hold per change, whose yes lifts it, who is told, what the
// merge claim reads, and what the admin console lists.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/release-holds-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const holds = require('../src/services/release-holds');
const { readClaimFacts } = require('../src/workflow/rules/merge-claim.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a held change against the full schema', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `release_holds_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, { isAdmin = false, readonly = false, email = null } = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_admin, admin_readonly, email)
     VALUES ($1, 'x', TRUE, $2, $3, $4) RETURNING id`, [username, isAdmin, readonly, email],
  )).rows[0].id;
  const maya = await user('maya');
  const boss = await user('boss', { isAdmin: true, email: 'boss@example.com' });
  const chief = await user('chief', { isAdmin: true });
  const watcher = await user('watcher', { isAdmin: true, readonly: true, email: 'watcher@example.com' });

  const appId = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Recipe Box', 'recipe-box', 'running', $1, 'public', 'public') RETURNING id`, [maya])).rows[0].id;
  let branch = 0;
  const change = async (authorId, status = 'promoted') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at)
     VALUES ($1, $2, $3, $4, 'Add a tip jar', NOW()) RETURNING id`,
    [appId, authorId, `b/${branch += 1}`, status])).rows[0].id;
  const vote = (sessionId, userId, side = 'yes') => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
     VALUES ($1, $2, $3, (SELECT approval_epoch FROM chat_sessions WHERE id = $1))
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, approval_epoch = EXCLUDED.approval_epoch`,
    [sessionId, userId, side]);

  // ── One waiting hold per change, replaced in place by a later head ──────
  const tips = await change(maya);
  assert.equal(await holds.gateFor(pool, tips), null, 'no hold, no admin step');
  const opened = await holds.apply(pool, { sessionId: tips, appId, commitHash: 'A'.repeat(40), rules: ['wallet'] });
  assert.equal(opened.state, 'held');
  assert.equal(opened.opened, true);
  const again = await holds.apply(pool, { sessionId: tips, appId, commitHash: 'b'.repeat(40), rules: ['wallet', 'people'] });
  assert.equal(again.opened, false, 'the same hold, with its reasons brought up to date');
  assert.equal(again.id, opened.id);
  const stored = (await pool.query('SELECT head_sha, rules, status FROM release_holds WHERE session_id = $1', [tips])).rows;
  assert.deepEqual(stored, [{ head_sha: 'b'.repeat(40), rules: ['wallet', 'people'], status: 'waiting' }]);

  // ── Whose yes lifts it ─────────────────────────────────────────────────
  let gate = await holds.gateFor(pool, tips);
  assert.deepEqual([gate.rules, gate.approved, gate.needsAnotherAdmin], [['wallet', 'people'], false, false]);
  assert.deepEqual(pick(await readClaimFacts(pool, tips)), { held: true, holdAdminYes: false });
  await vote(tips, maya);
  await vote(tips, watcher);
  assert.equal((await holds.gateFor(pool, tips)).approved, false, 'not the author\'s yes, nor a view-only admin\'s');
  await vote(tips, boss);
  assert.equal((await holds.gateFor(pool, tips)).approved, true, 'a full admin\'s yes lifts it');
  assert.deepEqual(pick(await readClaimFacts(pool, tips)), { held: true, holdAdminYes: true });
  // A new version clears the approvals, and the admin's yes with them.
  await pool.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [tips]);
  assert.equal((await holds.gateFor(pool, tips)).approved, false, 'an approval a new version cleared is not remembered');
  assert.deepEqual((await holds.forSessions(pool, [tips, 999999])).get(tips).rules, ['wallet', 'people']);

  // ── An admin's own change needs another admin ──────────────────────────
  const own = await change(boss);
  await holds.apply(pool, { sessionId: own, appId, commitHash: 'c'.repeat(40), rules: ['secret'] });
  await vote(own, boss);
  gate = await holds.gateFor(pool, own);
  assert.deepEqual([gate.approved, gate.needsAnotherAdmin], [false, true]);
  await vote(own, chief);
  assert.equal((await holds.gateFor(pool, own)).approved, true);

  // ── Who is told, and that it is once ───────────────────────────────────
  const mails = [];
  const deps = {
    notifications: { hydrateAndPush: async () => {} },
    sendMail: async (_config, mail) => { mails.push(mail); },
  };
  const draft = await change(maya, 'active');
  await holds.apply(pool, { sessionId: draft, appId, commitHash: 'd'.repeat(40), rules: ['script'] });
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: draft, deps }), { notified: 0 },
    'a change still being worked on asks nobody');

  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: tips, deps }), { notified: 2 });
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: tips, deps }), { notified: 0 }, 'told once');
  const bell = (await pool.query(
    `SELECT user_id, app_id, session_id, source_user_id, detail FROM notifications WHERE kind = 'release_hold' AND session_id = $1 ORDER BY user_id`,
    [tips])).rows;
  assert.deepEqual(bell.map((r) => r.user_id), [boss, chief], 'full admins only');
  assert.deepEqual([bell[0].app_id, bell[0].source_user_id, bell[0].detail], [appId, maya, 'wallet,people']);
  assert.deepEqual(mails.map((m) => m.to), ['boss@example.com'], 'a mail to each admin who has an address');
  assert.equal(mails[0].author, 'maya');
  assert.equal(mails[0].appName, 'Recipe Box');

  // The author of a held change is not asked, admin or not.
  await holds.notifyIfDue({ pool, sessionId: own, deps });
  const ownBell = (await pool.query(
    `SELECT user_id FROM notifications WHERE kind = 'release_hold' AND session_id = $1`, [own])).rows;
  assert.deepEqual(ownBell.map((r) => r.user_id), [chief]);

  // The clock finds the one proposed after it was held.
  await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [draft]);
  const swept = await holds.sweep(pool, { config: {}, deps });
  assert.deepEqual(swept, { due: 1, notified: 1 });
  assert.deepEqual(await holds.sweep(pool, { config: {}, deps }), { due: 0, notified: 0 });

  // ── A change the rules could not read in full is told about, not held ──
  const big = await change(maya);
  const noticed = await holds.apply(pool, { sessionId: big, appId, commitHash: 'e'.repeat(40), rules: ['unread'] });
  assert.deepEqual([noticed.state, noticed.opened], ['notice', true]);
  assert.equal(await holds.gateFor(pool, big), null, 'no admin step');
  assert.deepEqual(pick(await readClaimFacts(pool, big)), { held: false, holdAdminYes: false }, 'and the merge claim reads no hold');
  assert.equal((await holds.forSessions(pool, [big])).has(big), false, 'nor does the card');
  const sameNotice = await holds.apply(pool, { sessionId: big, appId, commitHash: 'f'.repeat(40), rules: ['unread'] });
  assert.deepEqual([sameNotice.id, sameNotice.opened], [noticed.id, false], 'one notice per change');
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: big, deps }), { notified: 2 });
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: big, deps }), { notified: 0 }, 'told once');
  // The same version read again tells nobody; a new one that is still not
  // read in full does, since being told of one says nothing about the next.
  await holds.apply(pool, { sessionId: big, appId, commitHash: 'f'.repeat(40), rules: ['unread'] });
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: big, deps }), { notified: 0 });
  await holds.apply(pool, { sessionId: big, appId, commitHash: '9'.repeat(40), rules: ['unread'] });
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: big, deps }), { notified: 2 }, 'a new version is told about again');
  const told = (await pool.query(
    `SELECT DISTINCT detail FROM notifications WHERE kind = 'release_hold' AND session_id = $1`, [big])).rows;
  assert.deepEqual(told, [{ detail: 'notice:unread' }]);
  assert.equal(mails[mails.length - 1].held, false);
  assert.equal((await holds.listForAdmin(pool, { viewerId: boss })).history.find((h) => h.sessionId === big).outcome, 'notice',
    'the console lists it as told, never as waiting');
  // An admin's no on it is an ordinary vote: nothing is declined or closed.
  assert.equal(await holds.onVote({ pool, session: { id: big, user_id: maya, status: 'promoted' }, user: { id: boss }, vote: 'no', reason: 'too big' }), null);
  // The next version trips a rule that holds: it is held, with both reasons,
  // and its admins are told again, as a hold.
  const nowHeld = await holds.apply(pool, { sessionId: big, appId, commitHash: 'a'.repeat(40), rules: ['wallet', 'unread'] });
  assert.equal(nowHeld.state, 'held');
  assert.deepEqual((await holds.gateFor(pool, big)).rules, ['wallet', 'unread']);
  assert.deepEqual((await pool.query(
    `SELECT status FROM release_holds WHERE session_id = $1 ORDER BY id`, [big])).rows.map((r) => r.status), ['fixed', 'waiting']);
  assert.deepEqual(await holds.notifyIfDue({ pool, sessionId: big, deps }), { notified: 2 });
  // And one read whole after that owes nobody anything.
  assert.deepEqual(await holds.apply(pool, { sessionId: big, appId, commitHash: 'b'.repeat(40), rules: [] }), { state: 'fixed', rules: [] });
  const quiet = await change(maya, 'active');
  await holds.apply(pool, { sessionId: quiet, appId, commitHash: 'c'.repeat(40), rules: ['unread'] });
  await holds.apply(pool, { sessionId: quiet, appId, commitHash: 'd'.repeat(40), rules: [] });
  await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [quiet]);
  assert.deepEqual(await holds.sweep(pool, { config: {}, deps }), { due: 0, notified: 0 }, 'a notice about a version that is gone is never sent');
  await pool.query('DELETE FROM release_holds WHERE session_id = ANY($1::int[])', [[big, quiet]]);

  // ── What the console lists ─────────────────────────────────────────────
  let lists = await holds.listForAdmin(pool, { viewerId: boss });
  assert.deepEqual(lists.waiting.map((h) => h.sessionId), [tips, draft], 'oldest first; the approved one is not waiting');
  assert.deepEqual(lists.waiting[0].reasons, ['It lets the app send tokens', 'It starts keeping data about people']);
  assert.equal(lists.waiting[0].author, 'maya');
  assert.deepEqual(lists.history.map((h) => [h.sessionId, h.outcome]), [[own, 'approved']]);
  assert.equal(lists.history[0].needsAnotherAdmin, true, 'the viewer wrote it');
  assert.equal(lists.rules.length, 7);

  // ── A later head that trips nothing ends it; a no declines it ──────────
  assert.equal((await holds.apply(pool, { sessionId: draft, appId, commitHash: 'e'.repeat(40), rules: [] })).state, 'fixed');
  assert.equal(await holds.gateFor(pool, draft), null);
  assert.deepEqual(pick(await readClaimFacts(pool, draft)), { held: false, holdAdminYes: false });
  assert.equal((await holds.apply(pool, { sessionId: draft, appId, commitHash: 'f'.repeat(40), rules: [] })).state, 'clear');

  const archived = [];
  const closed = await holds.onVote({
    pool,
    session: { id: tips, user_id: maya, status: 'promoted', linked_issues: [], repo_url: 'https://github.com/acme/recipes' },
    user: { id: chief, username: 'chief' }, vote: 'no', reason: 'Tips need a limit first.',
    deps: { lifecycle: { archiveSession: async (args) => { archived.push(args.reason); return { archived: true }; } } },
  });
  assert.deepEqual(closed, { closed: true, archived: true });
  assert.deepEqual(archived, ['admin-declined']);
  await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [tips]);
  lists = await holds.listForAdmin(pool, { viewerId: chief });
  assert.deepEqual(lists.waiting, []);
  const declined = lists.history.find((h) => h.sessionId === tips);
  assert.deepEqual([declined.outcome, declined.decidedBy, declined.note], ['declined', 'chief', 'Tips need a limit first.']);
  assert.equal(lists.history.find((h) => h.sessionId === draft).outcome, 'fixed');

  // A change that was declined can be held again by a later one of its own.
  const reopened = await holds.apply(pool, { sessionId: tips, appId, commitHash: '1'.repeat(40), rules: ['wallet'] });
  assert.equal(reopened.opened, true);
});

function pick(facts) {
  return { held: facts.held, holdAdminYes: facts.holdAdminYes };
}
