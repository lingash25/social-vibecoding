'use strict';

// #6643: risky changes ask an admin (src/services/release-holds.js).
//
// What trips a hold, what a hold does to the merge steps and the card, who
// is told, and what an admin's vote does to it. The SQL the gate reads is
// exercised against a real database in tests/release-holds-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const holds = require('../src/services/release-holds');
const requirements = require('../src/services/merge-requirements');
const { ACTIONS } = require('../src/services/mail/actions');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const file = (name, lines) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, '@@ -1,2 +1,3 @@', ...lines].join('\n');

test('each rule reads only what a change adds', () => {
  assert.deepEqual(holds.tripped({ diff: file('public/app.js', ['+  await usernode.sendTransaction(to, amount);']) }), ['wallet']);
  assert.deepEqual(holds.tripped({ diff: file('public/app.js', ['-  await usernode.sendTransaction(to, amount);']) }), [],
    'taking a wallet send out holds nothing');
  assert.deepEqual(holds.tripped({ diff: file('server.js', ['+  CREATE TABLE IF NOT EXISTS tips (', '+    user_id INTEGER NOT NULL,', '+    email TEXT,', '+    amount INTEGER);']) }), ['people']);
  assert.deepEqual(holds.tripped({ diff: file('server.js', ['+  CREATE TABLE IF NOT EXISTS scores (', '+    points INTEGER);']) }), [],
    'a table with no person column is not data about people');
  assert.deepEqual(holds.tripped({ diff: file('dapp.json', ['+    { "key": "STRIPE_KEY", "private": true }']) }), ['secret']);
  assert.deepEqual(holds.tripped({ diff: file('config.json', ['+    { "key": "X", "private": true }']) }), [],
    'only dapp.json declares a secret');
  assert.deepEqual(holds.tripped({ diff: file('dapp.json', ['+  "permissions": ["geolocation"]']) }), ['capability']);
  assert.deepEqual(holds.tripped({ diff: file('public/index.html', ['+<script src="https://cdn.example.com/x.js"></script>']) }), ['script']);
  assert.deepEqual(holds.tripped({ diff: file('public/index.html', ['+<script src="/usernode-bridge/v1/bridge.js"></script>']) }), [],
    'the centrally hosted files are relative paths');
  assert.deepEqual(holds.tripped({ diff: '', contentFlagged: true }), ['content']);
});

test('the people rule holds a new table for contact or personal columns, not for saying whose a row is', () => {
  const table = (...columns) => holds.tripped({ diff: file('server.js', ['+  await pool.query(`CREATE TABLE IF NOT EXISTS spots (', ...columns.map((c) => `+    ${c},`), '+    created_at TIMESTAMPTZ DEFAULT NOW()', '+  )`);']) });
  // Whose row it is: what the platform hands every app about its person.
  assert.deepEqual(table('id SERIAL PRIMARY KEY', 'user_id INTEGER NOT NULL', 'username TEXT', 'usernode_pubkey TEXT'), []);
  assert.deepEqual(table('place_id INTEGER', 'ribbon TEXT', 'name TEXT', 'added_by INTEGER'), []);
  // Contact and personal details, however the column is named.
  for (const column of ['email TEXT', 'contact_email TEXT', 'phone_number TEXT', 'full_name TEXT', 'first_name TEXT',
    'date_of_birth DATE', 'birthday DATE', 'home_address TEXT', 'wallet_address TEXT', '"email" TEXT', 'postal_code TEXT']) {
    assert.deepEqual(table('user_id INTEGER', column), ['people'], column);
  }
  // A word inside another word is not that word.
  assert.deepEqual(table('emailed_at TIMESTAMPTZ', 'headphones BOOLEAN', 'zipped BOOLEAN'), []);
  // One line, and a column typed with a comma of its own.
  assert.deepEqual(holds.tripped({ diff: file('db.sql', ['+CREATE TABLE tips (id SERIAL, amount NUMERIC(10,2), phone TEXT);']) }), ['people']);
  assert.deepEqual(holds.tripped({ diff: file('db.sql', ['+CREATE TABLE tips (id SERIAL, amount NUMERIC(10,2), user_id INTEGER);']) }), []);
  // The word has to be a column of the new table, not anywhere in the file.
  assert.deepEqual(holds.tripped({ diff: file('server.js', [
    '+  await pool.query(`CREATE TABLE IF NOT EXISTS scores (points INTEGER, user_id INTEGER)`);',
    '+  // the address bar keeps the room',
    "+  const { rows } = await pool.query('SELECT email FROM invites WHERE id = $1', [id]);",
  ]) }), []);
  // The table ends at its closing bracket: the code after it is not columns.
  assert.deepEqual(holds.tripped({ diff: file('server.js', [
    '+  await db.exec(`CREATE TABLE IF NOT EXISTS scores (', '+    points INTEGER', '+  )`)', '+  const invite = {', '+    email: req.body.email,', '+  }',
  ]) }), []);
  // Two tables in one file: the second one's column still counts.
  assert.deepEqual(holds.tripped({ diff: file('server.js', [
    '+  CREATE TABLE IF NOT EXISTS a (', '+    id SERIAL', '+  );',
    '+  CREATE TABLE IF NOT EXISTS b (', '+    id SERIAL,', '+    phone TEXT', '+  );',
  ]) }), ['people']);
});

test('a test file trips nothing, and several rules come back in the listed order', () => {
  assert.deepEqual(holds.tripped({ diff: file('tests/app.test.js', ['+  usernode.sendTransaction(a, b);']) }), []);
  const diff = [
    file('dapp.json', ['+  "permissions": ["camera"],', '+  { "key": "K", "private": true }']),
    file('public/app.js', ['+  usernode.sendTransaction(a, b);']),
  ].join('\n');
  assert.deepEqual(holds.tripped({ diff, contentFlagged: true }), ['wallet', 'secret', 'capability', 'content']);
  assert.deepEqual(holds.RULE_KEYS, ['wallet', 'people', 'secret', 'capability', 'script', 'content', 'unread']);
  assert.deepEqual(holds.cleanRules(['content', 'nonsense', 'wallet']), ['wallet', 'content']);
});

test('every rule has its sentence in the catalog and on the card', () => {
  const view = read('public', 'js', 'app-view.js');
  for (const key of holds.RULE_KEYS) {
    assert.ok(message(`changes:hold.rule.${key}`), `changes:hold.rule.${key} exists`);
    assert.ok(view.includes(`${key}: 'changes:hold.rule.${key}'`), `the card words ${key}`);
  }
  assert.equal(message('changes:hold.title'), 'This change needs an admin’s approval');
  assert.equal(message('changes:hold.pillOther'), 'Needs another admin');
});

// A pool that answers each query by the first route whose pattern matches.
function pool(routes) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      for (const [pattern, answer] of routes) {
        if (pattern.test(String(sql))) return typeof answer === 'function' ? answer(params, String(sql)) : answer;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the platform\'s own app is never read, and a diff that cannot be read whole tells the admins without holding', async () => {
  const db = pool([[/INSERT INTO release_holds/, { rows: [{ id: 3, opened: true }], rowCount: 1 }]]);
  assert.equal(await holds.evaluate({
    pool: db, session: { id: 1 }, app: { id: 2, self_hosted: true }, repoOwner: 'o', repoName: 'r', commitHash: 'a'.repeat(40),
  }), null);
  holds._resetCache();
  const first = await holds.evaluate({
    pool: db, session: { id: 1 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'b'.repeat(40),
    deps: { isFirstVersion: async () => true, github: { getProposalDiff: async () => { throw new Error('never read'); } } },
  });
  assert.equal(first, null, 'a project\'s first version is not held');
  const out = await holds.evaluate({
    pool: db, session: { id: 1 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'b'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => { throw new Error('down'); } } },
  });
  assert.equal(out.state, 'notice', 'a change that could not be read is not held: the admins are told');
  assert.deepEqual(out.rules, ['unread']);
  const notice = db.seen.filter((q) => /INSERT INTO release_holds/.test(q.sql)).pop();
  assert.match(notice.sql, /VALUES \(\$1, \$2, \$3, \$4::text\[\], 'notice'\)/, 'a row no gate reads');
  assert.match(notice.sql, /ON CONFLICT \(session_id\) WHERE status = 'notice'/, 'one per change');
  assert.ok(db.seen.some((q) => /SET status = 'fixed'[\s\S]*status = 'waiting'/.test(q.sql)), 'and a hold it had for that reason alone ends');
  holds._resetCache();
  const cut = await holds.evaluate({
    pool: db, session: { id: 1 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'e'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => ({ diff: file('README.md', ['+hello']), truncated: true }) } },
  });
  assert.deepEqual([cut.state, cut.rules], ['notice', ['unread']], 'a diff cut off at the budget is told about too');
  assert.equal(holds.holds(['unread']), false);
  assert.equal(holds.holds(['unread', 'wallet']), true);
  assert.equal(holds.holds([]), false);
});

test('a cut-off diff whose read part trips a rule is held, with both reasons, and no notice is left to send', async () => {
  holds._resetCache();
  const told = [];
  const db = pool([[/INSERT INTO release_holds/, { rows: [{ id: 9, opened: true }], rowCount: 1 }]]);
  const out = await holds.evaluate({
    pool: db, session: { id: 12 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'f'.repeat(40),
    deps: {
      isFirstVersion: async () => false, notify: async (args) => { told.push(args.sessionId); },
      github: { getProposalDiff: async () => ({ diff: file('public/app.js', ['+usernode.sendTransaction(a, b);']), truncated: true }) },
    },
  });
  assert.deepEqual(out, { state: 'held', rules: ['wallet', 'unread'], id: 9, opened: true });
  assert.deepEqual(told, [12]);
  const insert = db.seen.find((q) => /INSERT INTO release_holds/.test(q.sql));
  assert.match(insert.sql, /ON CONFLICT \(session_id\) WHERE status = 'waiting'/);
  const ended = db.seen.findIndex((q) => /SET status = 'fixed'[\s\S]*status = 'notice'/.test(q.sql));
  assert.ok(ended >= 0 && ended < db.seen.indexOf(insert), 'the notice row ends before the hold opens');
});

test('a head that trips a rule opens a hold and tells the admins; one that trips none ends it', async () => {
  holds._resetCache();
  const told = [];
  const db = pool([
    [/INSERT INTO release_holds/, { rows: [{ id: 7, opened: true }], rowCount: 1 }],
    [/UPDATE release_holds SET status = 'fixed'/, { rows: [], rowCount: 1 }],
  ]);
  const github = { getProposalDiff: async () => ({ diff: file('public/app.js', ['+usernode.sendTransaction(a, b);']) }) };
  const held = await holds.evaluate({
    pool: db, session: { id: 11 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'c'.repeat(40),
    deps: { isFirstVersion: async () => false, github, notify: async (args) => { told.push(args.sessionId); } },
  });
  assert.deepEqual(held, { state: 'held', rules: ['wallet'], id: 7, opened: true });
  assert.deepEqual(told, [11]);
  const insert = db.seen.find((q) => /INSERT INTO release_holds/.test(q.sql));
  assert.match(insert.sql, /ON CONFLICT \(session_id\) WHERE status = 'waiting'/, 'one waiting hold per change');
  assert.deepEqual(insert.params[3], ['wallet']);

  const fixed = await holds.evaluate({
    pool: db, session: { id: 11 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'd'.repeat(40),
    deps: { isFirstVersion: async () => false, github: { getProposalDiff: async () => ({ diff: file('README.md', ['+hello']) }) }, notify: async () => { told.push('again'); } },
  });
  assert.deepEqual(fixed, { state: 'fixed', rules: [] });
  assert.deepEqual(told, [11], 'nobody is told about a hold that ended');
});

test('the admins are told once, never the author, and only for a change up for a vote', async () => {
  const pushed = [];
  const mails = [];
  const db = pool([
    [/UPDATE release_holds rh SET notified_at = NOW\(\)/, (params, sql) => {
      assert.match(sql, /rh\.notified_at IS NULL/, 'claimed once');
      assert.match(sql, /cs\.status = 'promoted'/, 'only once it is up for a vote');
      return { rows: [{ id: 7, rules: ['wallet', 'people'], session_id: params[0], author_id: 5, app_id: 2, app_slug: 'recipe-box', app_name: 'Recipe Box', title: 'Add a tip jar' }] };
    }],
    [/INSERT INTO notifications/, (params, sql) => {
      assert.match(sql, /admin\.is_admin = TRUE AND admin\.admin_readonly = FALSE/);
      assert.match(sql, /admin\.id IS DISTINCT FROM \$2/, 'never the author');
      assert.deepEqual(params, [11, 5, 2, 'wallet,people']);
      return { rows: [{ id: 100, user_id: 8 }, { id: 101, user_id: 9 }] };
    }],
    [/SELECT id, email, locale FROM users/, { rows: [{ id: 8, email: 'a@example.com', locale: null }] }],
    [/SELECT username FROM users/, { rows: [{ username: 'maya' }] }],
  ]);
  const out = await holds.notifyIfDue({
    pool: db, sessionId: 11,
    deps: {
      notifications: { hydrateAndPush: async (_pool, row) => { pushed.push(row.id); } },
      sendMail: async (_config, mail) => { mails.push(mail); },
    },
  });
  assert.deepEqual(out, { notified: 2 });
  assert.deepEqual(pushed, [100, 101]);
  assert.equal(mails.length, 1, 'an admin with no address gets the bell only');
  assert.equal(mails[0].kind, 'release_hold');
  assert.equal(mails[0].to, 'a@example.com');
  assert.deepEqual(mails[0].reasons, ['It lets the app send tokens', 'It starts keeping data about people']);
  assert.equal(mails[0].url, holds.changeUrl('recipe-box', 11));

  assert.equal(mails[0].held, true);

  const none = await holds.notifyIfDue({ pool: pool([]), sessionId: 11 });
  assert.deepEqual(none, { notified: 0 }, 'already told, or not up for a vote: nothing is sent');
});

test('a change that is only told about says so in the bell row and the mail', async () => {
  const mails = [];
  const db = pool([
    [/UPDATE release_holds rh SET notified_at = NOW\(\)/, (params, sql) => {
      assert.match(sql, /due\.status IN \('waiting', 'notice'\)/, 'a notice is claimed like a hold');
      assert.match(sql, /ORDER BY \(due\.status = 'waiting'\) DESC/, 'a hold first, when a change has both');
      return { rows: [{ id: 8, rules: ['unread'], status: 'notice', session_id: params[0], author_id: 5, app_id: 2, app_slug: 'calc', app_name: 'Calc', title: 'Add a search field' }] };
    }],
    [/INSERT INTO notifications/, (params) => {
      assert.equal(params[3], 'notice:unread', 'the detail says it is a notice');
      return { rows: [{ id: 100, user_id: 8 }] };
    }],
    [/SELECT id, email, locale FROM users/, { rows: [{ id: 8, email: 'a@example.com', locale: null }] }],
    [/SELECT username FROM users/, { rows: [{ username: 'maya' }] }],
  ]);
  const out = await holds.notifyIfDue({
    pool: db, sessionId: 21,
    deps: { notifications: { hydrateAndPush: async () => {} }, sendMail: async (_config, mail) => { mails.push(mail); } },
  });
  assert.deepEqual(out, { notified: 1 });
  assert.equal(mails[0].held, false);
  assert.deepEqual(mails[0].reasons, ['It could not be read in full']);
  assert.equal(holds.NOTICE_DETAIL, 'notice:');
});

test('the mail names the change, why it is held and where to vote', () => {
  const action = ACTIONS.release_hold;
  const v = action.values({ appName: 'Recipe Box', title: 'Add a tip jar', author: 'maya', reasons: ['It lets the app send tokens', 'It starts keeping data about people'], url: 'https://app.onhomeroom.com/#app/x/dev/proposals/1' });
  assert.equal(v.reasons, 'It lets the app send tokens. It starts keeping data about people.');
  assert.equal(v.author, '@maya');
  assert.equal(v.hasApp, true);
  assert.equal(action.values({ url: 'javascript:alert(1)' }).url, require('../src/services/cli-auth-constants').PRODUCTION_ORIGIN);
  assert.equal(action.values({}).title, 'A change');
  const seed = read('src', 'db', 'email-template-seeds.js');
  assert.match(seed, /release_hold: \{[\s\S]*?subject: `\{\{#if held\}\}⚠️ Approval needed: \{\{title\}\}\{\{else\}\}/, 'a held change\'s subject carries the warning sign');
  assert.equal(v.held, true, 'held unless the sender says otherwise');
  assert.equal(action.values({ held: false }).held, false);
});

test('the same mail, for a change that is only told about, says it is not held and asks for nothing', () => {
  const { englishTemplate } = require('../src/db/email-template-seeds');
  const { render } = require('../src/services/mail/template-language');
  const template = englishTemplate('release_hold');
  const values = (held) => ACTIONS.release_hold.values({ appName: 'Calc', title: 'Add a search field', author: 'maya', reasons: ['It could not be read in full'], held, url: 'https://app.onhomeroom.com/#app/calc/dev/proposals/1' });
  const told = render(template.text, values(false));
  assert.match(told, /^For your information\n\nAdd a search field in Calc, by @maya, is not held\./);
  assert.match(told, /Why you are told: It could not be read in full\./);
  assert.doesNotMatch(told, /Vote yes|cannot go live|Held for an admin/);
  assert.equal(render(template.subject, values(false)), 'Not read in full: Add a search field');
  const held = render(template.text, values(true));
  assert.match(held, /^Held for an admin\n\nAdd a search field in Calc, by @maya, cannot go live until an administrator approves it\./);
  assert.doesNotMatch(held, /For your information|is not held/);
  assert.equal(render(template.subject, values(true)), '⚠️ Approval needed: Add a search field');
});

function voteDeps(calls) {
  return {
    lifecycle: { archiveSession: async (args) => { calls.push(['archive', args.reason, args.sessionId]); return { archived: true }; } },
    requests: {
      comment: async (_o, _r, n, body) => { calls.push(['comment', n, body]); },
      close: async (_o, _r, n, opts) => { calls.push(['close', n, opts.reason, opts.closedBy]); },
    },
    pushNotificationToUser: (id) => calls.push(['bell', id]),
  };
}
const session = { id: 11, user_id: 5, status: 'promoted', linked_issues: [6643], repo_url: 'https://github.com/acme/recipes' };

test('a full admin\'s no closes the change and its request, with their reason', async () => {
  const calls = [];
  const db = pool([
    [/SELECT \(is_admin = TRUE AND admin_readonly = FALSE\) AS full_admin/, { rows: [{ full_admin: true }] }],
    [/UPDATE release_holds SET status = 'declined'/, (params) => {
      assert.deepEqual(params, [11, 8, 'Tips need a spending limit first.']);
      return { rows: [{ id: 7, rules: ['wallet'] }] };
    }],
  ]);
  const out = await holds.onVote({ pool: db, session, user: { id: 8, username: 'admin' }, vote: 'no', reason: 'Tips need a spending limit first.', deps: voteDeps(calls) });
  assert.deepEqual(out, { closed: true, archived: true });
  assert.deepEqual(calls[0], ['archive', 'admin-declined', 11]);
  assert.equal(calls[1][0], 'comment');
  assert.match(calls[1][2], /An admin did not approve the change[\s\S]*Tips need a spending limit first\./);
  assert.deepEqual(calls[2], ['close', 6643, 'not_planned', 8]);
});

test('a full admin\'s yes writes nothing to the hold: the gate reads the vote, and the other admins\' rows are read', async () => {
  const calls = [];
  const db = pool([
    [/full_admin/, { rows: [{ full_admin: true }] }],
    [/SELECT id FROM release_holds/, { rows: [{ id: 7 }] }],
    [/UPDATE notifications SET read_at = NOW\(\)/, { rows: [{ user_id: 9 }, { user_id: 9 }] }],
  ]);
  const out = await holds.onVote({ pool: db, session, user: { id: 8 }, vote: 'yes', deps: voteDeps(calls) });
  assert.deepEqual(out, { approved: true });
  assert.deepEqual(calls, [['bell', 9]]);
  assert.ok(!db.seen.some((q) => /UPDATE release_holds/.test(q.sql)));
});

test('the author, a view-only admin and a member change nothing about a hold', async () => {
  const calls = [];
  const none = pool([[/full_admin/, { rows: [{ full_admin: false }] }]]);
  assert.equal(await holds.onVote({ pool: none, session, user: { id: 8 }, vote: 'no', reason: 'x', deps: voteDeps(calls) }), null);
  const author = pool([[/full_admin/, { rows: [{ full_admin: true }] }]]);
  assert.equal(await holds.onVote({ pool: author, session, user: { id: 5 }, vote: 'no', reason: 'x', deps: voteDeps(calls) }), null,
    'an admin\'s own change is not theirs to decide');
  assert.equal(author.seen.length, 0);
  const notHeld = pool([[/full_admin/, { rows: [{ full_admin: true }] }]]);
  assert.equal(await holds.onVote({ pool: notHeld, session, user: { id: 8 }, vote: 'no', reason: 'x', deps: voteDeps(calls) }), null,
    'a no on a change that is not held is an ordinary vote');
  assert.deepEqual(calls, []);
});

test('the steps list carries the admin step from the moment the change is held', () => {
  const base = { id: 1, votes_required: 3, yes_count: 1, check_state: 'pending' };
  const without = requirements.readRequirements(base).gates.map((g) => g.key);
  assert.ok(!without.includes('admin_yes'));

  const held = requirements.readRequirements({ ...base, release_hold: { rules: ['wallet'], approved: false, needsAnotherAdmin: false } });
  const keys = held.gates.map((g) => g.key);
  assert.equal(keys[0], 'approvals');
  assert.equal(keys[1], 'admin_yes', 'right after the votes, where the gate checks it');
  const step = held.gates[1];
  assert.equal(step.state, 'waiting');
  assert.equal(step.actor, 'admin');
  assert.deepEqual(step.detail.rules, ['wallet']);
  assert.equal(step.detail.held, true);

  const other = requirements.readRequirements({ ...base, release_hold: { rules: ['wallet'], approved: false, needsAnotherAdmin: true } });
  assert.match(other.gates[1].detail.note, /another admin/);
  const approved = requirements.readRequirements({ ...base, release_hold: { rules: ['wallet'], approved: true, needsAnotherAdmin: false } });
  assert.equal(approved.gates[1].state, 'done');
});

test('a recorded run of the gate names the hold, and the live read still follows the votes', () => {
  const t = requirements.trace();
  t.context({ locked: false, held: true, holdRules: ['wallet'] });
  t.pass('approvals', { note: '3 of 3' });
  t.stop('admin_yes', 'waiting', { note: 'This change is held, so an admin has to vote yes' });
  const described = requirements.describe(t.toRecord());
  const step = described.find((g) => g.key === 'admin_yes');
  assert.ok(step, 'a held change has the admin step on an unlocked app');
  assert.equal(step.state, 'waiting');
});

test('the three merge paths read the same two facts', () => {
  const facts = read('src', 'workflow', 'merge-queue', 'facts.ts');
  const claim = read('src', 'workflow', 'rules', 'merge-claim.ts');
  for (const src of [facts, claim]) {
    assert.match(src, /FROM release_holds rh WHERE rh\.session_id = cs\.id AND rh\.status = 'waiting'\) AS held/);
    assert.match(src, /pv\.user_id IS DISTINCT FROM cs\.user_id\) AS hold_admin_yes/, 'the author\'s own yes never counts');
  }
  assert.match(claim, /\(f\.held && !f\.holdAdminYes\)\) return 'awaiting_admin'/);
  assert.match(facts, /r\.held === true && r\.hold_admin_yes === false\) \? 'lock'/);
  assert.match(holds.approvedSql('cs'), /rhv\.user_id IS DISTINCT FROM cs\.user_id/);
  const votes = read('src', 'routes', 'votes.js');
  assert.match(votes, /const releaseHold = await releaseHolds\.gateFor\(pool, session\.id\)/);
  assert.match(votes, /const adminYes = releaseHold \? releaseHold\.approved : await hasAdminYesVote\(pool, session\.id\)/);
});

test('the bell row is an admin\'s only, settles with the change, and wears the warning sign', () => {
  const server = read('src', 'services', 'notifications.js');
  const delivery = read('src', 'services', 'ws-delivery.js');
  for (const src of [server, delivery]) {
    assert.match(src, /n\.kind NOT IN \('openrouter_key_review', 'platform_limit', 'platform_incident', 'release_hold'\)/);
  }
  assert.ok(require('../src/workflow/rules/change-notifications.ts').DECIDED_ASK_KINDS.includes('release_hold'));
  const client = read('frontend', 'src', 'features', 'notifications', 'notifications.js');
  assert.match(client, /n\.kind === 'release_hold'[\s\S]{0,900}needsYou: true,\s+icon: '\\u26A0\\uFE0F'/);
  assert.equal(message('notifications:row.releaseHold.label'), 'Needs your approval');
  assert.equal(message('push:releaseHold.title'), 'A change needs your approval');
  // A change that is only told about: no warning sign, and no ask.
  const notice = /if \(\/\^notice:\/\.test\(String\(n\.detail \|\| ''\)\)\) \{\s+return \{([\s\S]*?)\};/.exec(client);
  assert.ok(notice, 'the row reads the detail the server wrote');
  assert.doesNotMatch(notice[1], /needsYou|26A0/);
  assert.match(notice[1], /notifications:row\.releaseHold\.noticeLabel/);
  assert.equal(message('notifications:row.releaseHold.noticeLabel'), 'Not read in full');
  assert.match(read('src', 'services', 'mobile-push-policy.js'), /\/\^notice:\/\.test\(String\(detail \|\| ''\)\)[\s\S]{0,200}push:releaseHold\.notice\.title/);
  assert.equal(message('push:releaseHold.notice.title'), 'A change was not read in full');
});

test('the clock tells admins about a change proposed after it was held', () => {
  assert.match(read('src', 'workflow', 'clock', 'services.ts'), /name: 'release-holds', everyMs: 2 \* MIN/);
  assert.equal(typeof holds.sweep, 'function');
});
