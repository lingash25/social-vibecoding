'use strict';

// Invite links against a real PostgreSQL (services/community-invites.js and
// the "Communities, stage 6: invite links" block of src/db/schema.sql).
//
// The block is lifted out of schema.sql and run as written, in a scratch
// schema beside the few tables it reads, so what is tested is the SQL that
// ships: apply_community_invite() and the trigger that applies a queued
// invite when an account is let in, however that happens.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `invites_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

/** The invite-links block of schema.sql, as it ships. */
function stageSixBlock() {
  const start = SCHEMA_SQL.indexOf('-- ── Communities, stage 6: invite links');
  assert.ok(start > 0, 'the invite-links block must be findable in schema.sql');
  const end = SCHEMA_SQL.indexOf('\n-- ── ', start + 10);
  assert.ok(end > start, 'and it must end at the next block');
  return SCHEMA_SQL.slice(start, end);
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT NOT NULL, display_name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      has_platform_access BOOLEAN NOT NULL DEFAULT FALSE,
      platform_access_granted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE,
      getting_started_seen JSONB);
    CREATE TABLE communities (id SERIAL PRIMARY KEY);
    CREATE TABLE apps (
      id SERIAL PRIMARY KEY, slug TEXT NOT NULL, name TEXT,
      created_by INTEGER, self_hosted BOOLEAN NOT NULL DEFAULT FALSE,
      collab_visibility TEXT NOT NULL DEFAULT 'public',
      view_visibility TEXT NOT NULL DEFAULT 'public',
      icon_emoji TEXT, icon_image_id TEXT,
      -- #3700: what a private community's invite preview reads beyond the
      -- link (community-invites.js entryFor), and the access check's own.
      icon_color TEXT, moderation_suspended_at TIMESTAMPTZ,
      manifest_snapshot JSONB, featured_illustration JSONB,
      approver_policy TEXT NOT NULL DEFAULT 'anyone', approvals_required INTEGER,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      community_id INTEGER REFERENCES communities(id));
    -- WP-D: the sketch a project still being built shows (pictureFor).
    CREATE TABLE app_sketches (
      app_id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      design JSONB, html TEXT, model TEXT, error TEXT, committed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ready_at TIMESTAMPTZ);
    -- What the page's picture reads (community-invites.js pictureFor).
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER, merged_at TIMESTAMPTZ,
      shots_state TEXT, shots_run_id TEXT, status TEXT);
    -- Whether its first version is on its way: "Maya is making …"
    -- (community-invites.js firstVersionPending).
    CREATE TABLE homeroom_bot_first_versions (
      app_id INTEGER PRIMARY KEY, bot_builds BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'waiting', issue_number INTEGER);
    CREATE TABLE homeroom_bot_runs (
      id SERIAL PRIMARY KEY, app_id INTEGER, issue_number INTEGER, proposal_session_id INTEGER);
    CREATE TABLE shot_runs (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE shot_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, story_id TEXT NOT NULL,
      side TEXT NOT NULL, variant TEXT NOT NULL, media TEXT NOT NULL,
      content_type TEXT NOT NULL, data BYTEA NOT NULL, sha256 TEXT NOT NULL,
      width INTEGER, height INTEGER);
    CREATE TABLE app_illustrations (app_id INTEGER PRIMARY KEY, id TEXT NOT NULL, dark_id TEXT);
    CREATE TABLE community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source VARCHAR(16) NOT NULL DEFAULT 'joined',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (community_id, user_id));
    CREATE TABLE app_collaborators (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL DEFAULT 'member',
      invited_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accepted_at TIMESTAMPTZ,
      -- #5104: how a member row was accepted; a redeemed link writes 'link'.
      accepted_via VARCHAR(16),
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_favorites (
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (app_id, user_id));
    CREATE TABLE app_admins (app_id INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE user_app_blocks (
      user_id INTEGER NOT NULL, app_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE events (
      id SERIAL PRIMARY KEY, user_id INTEGER, app_id INTEGER, session_id INTEGER,
      event_type TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
    -- What a redemption owes the Homeroom bot's DM machine (a joiner's hello),
    -- appended in the redemption's own transaction: the event stream's columns.
    CREATE TABLE wf_events (
      id BIGSERIAL PRIMARY KEY, machine TEXT NOT NULL, key TEXT NOT NULL, app_id INTEGER, type TEXT NOT NULL,
      payload JSONB NOT NULL, source JSONB NOT NULL, actor TEXT, request_key TEXT NOT NULL, caused_by BIGINT);
  `);
  await pool.query(stageSixBlock());
  // The fixture: ada (who had access before the invite tree), an open
  // community and a group.
  await pool.query(`
    INSERT INTO users (id, username, has_platform_access, is_admin) VALUES
      (1, 'ada', TRUE, FALSE), (2, 'bo', TRUE, FALSE), (3, 'cy', FALSE, FALSE),
      (4, 'dee', TRUE, FALSE), (5, 'eve', FALSE, FALSE), (6, 'fay', FALSE, FALSE),
      (7, 'gus', FALSE, FALSE), (9, 'root', TRUE, TRUE);
    UPDATE users SET display_name = 'Ada' WHERE id = 1;
    SELECT setval(pg_get_serial_sequence('users', 'id'), 20);
    INSERT INTO communities (id) VALUES (1), (2);
    INSERT INTO apps (id, slug, name, created_by, collab_visibility, view_visibility, community_id) VALUES
      (1, 'arena', 'Arena', 1, 'public', 'public', 1),
      (2, 'book-club', 'Book Club', 1, 'private', 'private', 2);
    INSERT INTO community_members (community_id, user_id, source) VALUES (1, 1, 'creator'), (2, 1, 'creator');
    INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 1, 'member');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

const ADA = { id: 1, username: 'ada', isAdmin: false, hasPlatformAccess: true };
const as = (id, username, hasPlatformAccess) => ({ id, username, isAdmin: false, hasPlatformAccess });
const APP_COLUMNS = 'id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id';

test('invite links against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool } = setup;
  const invites = require('../src/services/community-invites');
  const waitlist = require('../src/services/waitlist');
  const app = async (slug) => (await pool.query(`SELECT ${APP_COLUMNS} FROM apps WHERE slug = $1`, [slug])).rows[0];
  const member = async (communityId, userId) => (await pool.query(
    'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId])).rows.length === 1;
  try {
    let token;
    await t.test('a member makes a link; somebody outside the project cannot', async () => {
      const arena = await app('arena');
      const refused = await invites.createInvite(pool, { app: arena, user: as(2, 'bo', true) });
      assert.equal(refused.status, 403);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 2, maxUses: 2 });
      assert.ok(made.ok);
      assert.match(made.link.token, invites.TOKEN_RE);
      assert.equal(made.link.path, `/invite/${made.link.token}`);
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, days: 31 })).status, 400, 'days past the limit');
      assert.equal((await invites.createInvite(pool, { app: arena, user: ADA, maxUses: -1 })).status, 400, 'uses below it');
      token = made.link.token;
      const preview = await invites.preview(pool, token);
      assert.deepEqual(
        { live: preview.live, name: preview.project.name, inviter: preview.inviter, memberCount: preview.memberCount },
        { live: true, name: 'Arena', inviter: 'ada', memberCount: 1 },
      );
      assert.equal(preview.project.slug, undefined, 'the address comes after joining');
      assert.equal(preview.building, false, 'no first version on its way: made, not being made');
      assert.equal('buildLine' in preview, false, 'no build step on a signed-out preview (#4049, rule 5)');
    });

    await t.test('somebody with access joins on the spot, pinned like Join; following again spends nothing', async () => {
      const bo = as(2, 'bo', true);
      // A new account, still to answer the join screen: the link answers it.
      await pool.query('UPDATE users SET needs_communities_choice = TRUE WHERE id = 2');
      const joined = await invites.redeem(pool, { token, user: bo });
      const answered = await pool.query(
        "SELECT needs_communities_choice, getting_started_seen->>'join_answer' AS answer FROM users WHERE id = 2");
      assert.deepEqual(answered.rows, [{ needs_communities_choice: false, answer: 'invite' }]);
      // The standing says when, and that the account is about as old as that.
      const standing = await invites.standing(pool, token, bo);
      assert.equal(standing.mine, 'joined');
      assert.ok(Date.now() - Date.parse(standing.joinedAt) < 60 * 1000);
      assert.equal(standing.newAccount, true);
      assert.deepEqual([joined.status, joined.slug, joined.name], ['joined', 'arena', 'Arena']);
      assert.equal(await member(1, 2), true);
      const pin = await pool.query('SELECT hidden FROM app_favorites WHERE app_id = 1 AND user_id = 2');
      assert.deepEqual(pin.rows, [{ hidden: false }]);
      assert.equal((await invites.redeem(pool, { token, user: bo })).status, 'member');
      const { rows } = await pool.query('SELECT uses FROM community_invites WHERE token = $1', [token]);
      assert.equal(rows[0].uses, 1);
      // Their hello is owed to the bot's DM machine in the redemption itself,
      // once (a second redemption joins nobody new).
      const { rows: greets } = await pool.query(`SELECT machine, key, type, payload FROM wf_events WHERE type = 'Greet' AND key = 'person:2'`);
      assert.deepEqual(greets.map((g) => [g.machine, g.payload.kind, g.payload.appId]), [['bot-dm', 'joiner', 1]]);
    });

    await t.test('somebody still waiting joins as a private member, and letting them in keeps them in', async () => {
      const cy = as(3, 'cy', false);
      const joined = await invites.redeem(pool, { token, user: cy });
      assert.deepEqual([joined.status, joined.slug, joined.privateMember], ['joined', 'arena', true]);
      assert.equal(await member(1, 3), true, 'in the community now, before they are let in');
      const tier = await pool.query(
        'SELECT has_platform_access, private_member_since IS NOT NULL AS private FROM users WHERE id = 3');
      assert.deepEqual(tier.rows, [{ has_platform_access: false, private: true }], 'still waiting, as a private member');
      assert.deepEqual(await invites.queuedFor(pool, 3), [], 'nothing left queued');
      assert.equal((await invites.redeem(pool, { token, user: cy })).status, 'member', 'a second follow spends nothing');
      await waitlist.grantPlatformAccess(pool, 3, { manualRelease: true });
      assert.equal(await member(1, 3), true, 'still in once let in');
      const { rows } = await pool.query('SELECT status, applied_at IS NOT NULL AS applied FROM community_invite_redemptions WHERE user_id = 3');
      assert.deepEqual(rows, [{ status: 'joined', applied: true }]);
      const gen = await pool.query('SELECT invite_generation FROM users WHERE id = 3');
      assert.equal(gen.rows[0].invite_generation, 0, 'let off the waitlist by hand is generation 0');
    });

    await t.test('a redemption queued before private membership is applied when its link is followed again, spending nothing', async () => {
      const arena = await app('arena');
      const made = await invites.createInvite(pool, { app: arena, user: ADA });
      const { rows: [{ id }] } = await pool.query("INSERT INTO users (username) VALUES ('quinn') RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')", [made.link.id, id]);
      await pool.query('UPDATE community_invites SET uses = 1 WHERE id = $1', [made.link.id]);
      const again = await invites.redeem(pool, { token: made.link.token, user: as(id, 'quinn', false) });
      assert.deepEqual([again.status, again.slug, again.privateMember], ['joined', 'arena', true]);
      assert.equal(await member(1, id), true);
      const { rows } = await pool.query('SELECT uses FROM community_invites WHERE id = $1', [made.link.id]);
      assert.equal(rows[0].uses, 1, 'its use was spent when it was queued');
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
    });

    await t.test('a link used as often as it allows is dead, and says only why', async () => {
      const refused = await invites.redeem(pool, { token, user: as(4, 'dee', true) });
      assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 410, 'used_up']);
      assert.deepEqual(await invites.preview(pool, token), { live: false, reason: 'used_up' });
    });

    await t.test('a group\'s link makes a collaborator; turning it off cancels who it queued', async () => {
      const group = await app('book-club');
      const made = await invites.createInvite(pool, { app: group, user: ADA });
      const joined = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(joined.status, 'joined');
      const collab = await pool.query('SELECT status, invited_by, accepted_via FROM app_collaborators WHERE app_id = 2 AND user_id = 4');
      assert.deepEqual(collab.rows, [{ status: 'member', invited_by: 1, accepted_via: 'link' }]);
      assert.equal(await member(2, 4), true);
      const eve = await invites.redeem(pool, { token: made.link.token, user: as(5, 'eve', false) });
      assert.deepEqual([eve.status, eve.privateMember], ['joined', true], 'somebody still waiting joins as a private member');
      const eveCollab = await pool.query('SELECT status FROM app_collaborators WHERE app_id = 2 AND user_id = 5');
      assert.deepEqual(eveCollab.rows, [{ status: 'member' }], 'a collaborator like anybody the link lets in');
      // What turning it off cancels is a redemption still queued: one from
      // before private membership, or one the link could not grant then.
      const { rows: [{ id: zed }] } = await pool.query("INSERT INTO users (username) VALUES ('zed') RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')", [made.link.id, zed]);
      assert.equal((await invites.revokeInvite(pool, { inviteId: made.link.id, user: as(2, 'bo', true) })).status, 404,
        'a stranger cannot, and is not told it exists');
      assert.deepEqual(await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA }), { ok: true, cancelled: 1 });
      await waitlist.grantPlatformAccess(pool, zed);
      await waitlist.grantPlatformAccess(pool, 5);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = $1', [zed]);
      assert.equal(none.rows.length, 0, 'a cancelled invite is not applied on release');
      assert.equal(await member(2, 5), true, 'and eve, let in, is still in');
      assert.equal((await invites.preview(pool, made.link.token)).reason, 'revoked');
    });

    await t.test('#3700: a private community\'s live link is an invite preview from the link alone; only Join lets anyone in', async () => {
      const appAccess = require('../src/services/app-access');
      const group = await app('book-club');
      await pool.query(`INSERT INTO users (id, username, has_platform_access) VALUES
        (13, 'jo', TRUE), (14, 'kit', TRUE), (15, 'lou', TRUE), (16, 'max', TRUE)`);
      await pool.query(`UPDATE apps SET icon_color = '#2e6660', manifest_snapshot = '{"description":"Our monthly pick"}' WHERE id = 2`);
      const jo = as(13, 'jo', true);
      const opens = (user) => appAccess.getAppForUser(pool, 'book-club', user, 'view', appAccess.ACCESS_COLUMNS);
      const made = await invites.createInvite(pool, { app: group, user: ADA, note: 'Come read' });
      const usesOf = async () => (await pool.query('SELECT uses FROM community_invites WHERE id = $1', [made.link.id])).rows[0].uses;

      // A non-member, link or no link, is refused by the gates as before.
      assert.equal(await opens(jo), null, 'the existing view gate 404s a non-member');
      const standing = await invites.standing(pool, made.link.token, jo);
      assert.deepEqual([standing.live, standing.mine, standing.slug, standing.page], [true, null, null, null]);
      assert.deepEqual(standing.invitePreview, { iconColor: '#2e6660', audienceLabel: 'Private community' });
      assert.deepEqual(
        [standing.project.name, standing.project.description, standing.inviter, standing.note, standing.memberCount],
        ['Book Club', 'Our monthly pick', 'ada', 'Come read', (await pool.query('SELECT COUNT(*)::int AS n FROM community_members WHERE community_id = 2')).rows[0].n],
      );
      // Only what the link's own preview says: no other member, no item, no
      // address of the project.
      const text = JSON.stringify(standing);
      const { rows: others } = await pool.query(
        `SELECT u.username FROM community_members m JOIN users u ON u.id = m.user_id
          WHERE m.community_id = 2 AND u.username <> 'ada'`);
      assert.ok(others.length > 0, 'the group has members besides its inviter');
      for (const { username } of others) assert.equal(text.includes(`"${username}"`), false, `${username} is not named`);
      assert.doesNotMatch(text, /book-club|\/app\//, 'nor the project\'s address');
      for (const key of ['members', 'items', 'proposals', 'issues', 'channel', 'activity', 'repo_url']) {
        assert.equal(text.includes(`"${key}"`), false, `no ${key}`);
      }
      assert.equal(await opens(jo), null, 'and reading it opened nothing');

      // A link that is not live shows no preview: turned off, expired, used
      // up, or its maker no longer in the group (deadReason, redeem's rule).
      const deadly = [
        ['revoked', async (link) => invites.revokeInvite(pool, { inviteId: link.id, user: ADA })],
        ['expired', async (link) => pool.query("UPDATE community_invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [link.id])],
        ['used_up', async (link) => pool.query('UPDATE community_invites SET uses = max_uses WHERE id = $1', [link.id])],
      ];
      for (const [reason, kill] of deadly) {
        const link = (await invites.createInvite(pool, { app: group, user: ADA })).link;
        await kill(link);
        const dead = await invites.standing(pool, link.token, jo);
        assert.deepEqual([dead.live, dead.reason, dead.page, dead.invitePreview, dead.project], [false, reason, null, null, undefined], reason);
      }
      await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 15, 'member')");
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES (2, 15)');
      const lous = (await invites.createInvite(pool, { app: group, user: as(15, 'lou', true) })).link;
      await pool.query('DELETE FROM app_collaborators WHERE app_id = 2 AND user_id = 15');
      const gone = await invites.standing(pool, lous.token, jo);
      assert.deepEqual([gone.live, gone.reason, gone.invitePreview], [false, 'revoked', null], 'a maker out of the group');

      // A suspended app, or one this viewer blocked: no preview either.
      await pool.query('UPDATE apps SET moderation_suspended_at = NOW() WHERE id = 2');
      assert.equal((await invites.standing(pool, made.link.token, as(14, 'kit', true))).invitePreview, null, 'suspended');
      await pool.query('UPDATE apps SET moderation_suspended_at = NULL WHERE id = 2');
      await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES (14, 2)');
      assert.equal((await invites.standing(pool, made.link.token, as(14, 'kit', true))).invitePreview, null, 'blocked');

      // Join through the preview: a use spent, a member, the app open to them.
      const before = await usesOf();
      const joined = await invites.redeem(pool, { token: made.link.token, user: jo });
      assert.deepEqual([joined.status, joined.slug], ['joined', 'book-club']);
      assert.equal(await usesOf(), before + 1);
      assert.ok(await opens(jo), 'a member now, through the gate the link did not loosen');
      // An existing member following it again: the hub, as before.
      const again = await invites.standing(pool, made.link.token, jo);
      assert.deepEqual([again.mine, again.slug, again.page, again.invitePreview], ['joined', 'book-club', null, null]);
      // And a public community's link is still its page.
      const arenaLink = (await invites.createInvite(pool, { app: await app('arena'), user: ADA })).link;
      const pub = await invites.standing(pool, arenaLink.token, as(16, 'max', true));
      assert.deepEqual([pub.page, pub.invitePreview], ['arena', null]);
    });

    await t.test('a link dies with its maker\'s standing, and so does a queued invite from it', async () => {
      const group = await app('book-club');
      await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES (2, 2, 'member')");
      await pool.query("INSERT INTO community_members (community_id, user_id) VALUES (2, 2) ON CONFLICT DO NOTHING");
      const made = await invites.createInvite(pool, { app: group, user: as(2, 'bo', true) });
      assert.ok(made.ok);
      const gus = await invites.redeem(pool, { token: made.link.token, user: as(7, 'gus', false) });
      assert.deepEqual([gus.status, gus.privateMember], ['joined', true], 'gus joins while bo can still grant it');
      const { rows: [{ id: una }] } = await pool.query("INSERT INTO users (username) VALUES ('una') RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')", [made.link.id, una]);
      // bo is removed from the group.
      await pool.query('DELETE FROM app_collaborators WHERE app_id = 2 AND user_id = 2');
      assert.deepEqual(await invites.preview(pool, made.link.token), { live: false, reason: 'revoked' });
      const refused = await invites.redeem(pool, { token: made.link.token, user: as(4, 'dee', true) });
      assert.equal(refused.status, 'member', 'dee is already in it from ada\'s link, so nothing to refuse');
      const stranger = await pool.query("INSERT INTO users (username, has_platform_access) VALUES ('hal', TRUE) RETURNING id");
      const hal = await invites.redeem(pool, { token: made.link.token, user: as(stranger.rows[0].id, 'hal', true) });
      assert.deepEqual([hal.ok, hal.reason], [false, 'revoked']);
      // And a queued follow of it from before does not join anybody: not on a
      // second follow (the link is dead) and not on release.
      const late = await invites.redeem(pool, { token: made.link.token, user: as(una, 'una', false) });
      assert.notEqual(late.status, 'joined', 'una, queued on it, is not let in by following it again');
      await waitlist.grantPlatformAccess(pool, una);
      const none = await pool.query('SELECT 1 FROM app_collaborators WHERE app_id = 2 AND user_id = $1', [una]);
      assert.equal(none.rows.length, 0, 'una, queued on it, is not added on release');
      // Put gus back on the waitlist, out of the group, for the tree case below.
      await pool.query('UPDATE users SET has_platform_access = FALSE, invite_generation = NULL, private_member_since = NULL WHERE id = 7');
      await pool.query('DELETE FROM community_invite_redemptions WHERE user_id = 7');
      await pool.query('DELETE FROM app_collaborators WHERE user_id = 7');
      await pool.query('DELETE FROM community_members WHERE user_id = 7');
    });

    await t.test('a link carries its maker\'s note, and its page shows the project: an after-shot, else the card image', async () => {
      const group = await app('book-club');
      const refused = await invites.createInvite(pool, { app: group, user: ADA, note: 'x'.repeat(281) });
      assert.equal(refused.status, 400);
      const made = await invites.createInvite(pool, { app: group, user: ADA, note: '  Come  read with us! ' });
      assert.equal(made.link.note, 'Come read with us!');
      await pool.query(`UPDATE apps SET manifest_snapshot = '{"description":"Our monthly pick"}' WHERE id = 2`);
      let preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(
        [preview.inviterName, preview.inviterMadeIt, preview.note, preview.project.description, preview.project.picture],
        ['Ada', true, 'Come read with us!', 'Our monthly pick', null],
      );
      assert.equal(await invites.pictureBytes(pool, made.link.token), null, 'nothing to show yet');
      // The card image its group chose, served by its own id.
      await pool.query(`UPDATE apps SET featured_illustration = '{"zoom":1,"x":0,"y":0}' WHERE id = 2`);
      await pool.query(`INSERT INTO app_illustrations (app_id, id, dark_id) VALUES (2, 'light1', 'dark1')`);
      preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, { kind: 'illustration', url: '/app-illustrations/light1', darkUrl: '/app-illustrations/dark1' });
      // A merged change's phone-shaped after-shot wins; an unmerged one, a
      // before-shot or a landscape one never shows.
      await pool.query(`
        INSERT INTO shot_runs (id, state) VALUES ('r1', 'verified'), ('r2', 'verified');
        INSERT INTO chat_sessions (id, app_id, merged_at, shots_state, shots_run_id) VALUES
          (1, 2, NOW() - INTERVAL '1 day', 'verified', 'r1'),
          (2, 2, NULL, 'verified', 'r2');
        INSERT INTO shot_artifacts (id, run_id, story_id, side, variant, media, content_type, data, sha256, width, height) VALUES
          ('wide', 'r1', 's1', 'head', 'context', 'png', 'image/png', '\\x01', 'aa', 1280, 800),
          ('before', 'r1', 's1', 'base', 'context', 'png', 'image/png', '\\x02', 'bb', 390, 844),
          ('phone', 'r1', 's1', 'head', 'context', 'png', 'image/png', '\\x89504e47', 'cc', 390, 844),
          ('unmerged', 'r2', 's1', 'head', 'context', 'png', 'image/png', '\\x03', 'dd', 390, 844);
      `);
      preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, { kind: 'shot', url: `/api/public/invites/${made.link.token}/picture`, darkUrl: null });
      const bytes = await invites.pictureBytes(pool, made.link.token);
      assert.deepEqual([bytes.contentType, bytes.sha256, bytes.data.toString('hex')], ['image/png', 'cc', '89504e47']);
      // Turning the link off turns its picture off too.
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal(await invites.pictureBytes(pool, made.link.token), null);
    });

    await t.test('WP-D: a link that works until it is turned off, for anyone it reaches', async () => {
      const arena = await app('arena');
      await pool.query(`INSERT INTO users (id, username, has_platform_access) VALUES (11, 'hal', TRUE), (12, 'ivy', TRUE)`);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 0, maxUses: 0, note: 'Come try it' });
      assert.ok(made.ok);
      assert.deepEqual([made.link.expiresAt, made.link.maxUses], [null, null]);
      const { rows: [row] } = await pool.query('SELECT expires_at, max_uses FROM community_invites WHERE id = $1', [made.link.id]);
      assert.deepEqual(row, { expires_at: null, max_uses: null });
      // The event is written without waiting (events.record), so this link's
      // own row is waited for, not whichever was newest a moment ago.
      let created = null;
      for (let i = 0; i < 40 && !created; i += 1) {
        ({ rows: [created] } = await pool.query(
          `SELECT metadata FROM events
            WHERE event_type = 'invite_link_created' AND (metadata->>'inviteId')::int = $1`, [made.link.id]));
        if (!created) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(created, 'the link\'s own event');
      assert.deepEqual([created.metadata.days, created.metadata.maxUses], [null, null]);
      assert.equal((await invites.preview(pool, made.link.token)).expiresAt, null);
      assert.ok((await invites.listInvites(pool, { app: arena, user: ADA })).links.some((l) => l.id === made.link.id), 'listed as live');
      for (const [id, name] of [[11, 'hal'], [12, 'ivy']]) {
        assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(id, name, true) })).status, 'joined');
      }
      assert.equal((await invites.preview(pool, made.link.token)).live, true, 'still live after it is used');
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal((await invites.preview(pool, made.link.token)).reason, 'revoked', 'until it is turned off');
    });

    await t.test('#4779: a link says who is still waiting on it, and one that ended stays listed for 30 days', async () => {
      const arena = await app('arena');
      const links = async () => (await invites.listInvites(pool, { app: arena, user: ADA })).links;
      // A new link serializes like the list does, with nobody waiting on it yet.
      const fresh = await invites.createInvite(pool, { app: arena, user: ADA, days: 7, maxUses: 25 });
      assert.ok(fresh.ok);
      assert.deepEqual({ waiting: fresh.link.waiting, joined: fresh.link.joined, status: fresh.link.status },
        { waiting: 0, joined: 0, status: 'live' });
      // Somebody without access follows it and is not let in yet (a queued
      // redemption, as private membership leaves one waiting on nothing):
      // the row counts them, and the person hal joined is the joined count.
      // These people carry explicit ids well above every other subtest's, so
      // this subtest leaves the id sequence as it found it (a later one
      // inserts 31 and 32 by hand), and hal is its own joiner, not dee
      // (#4780 below redeems with dee expecting to join on the spot).
      const { rows: [{ id: queuedId }] } = await pool.query("INSERT INTO users (id, username) VALUES (101, 'noor') RETURNING id");
      const { rows: [{ id: joinedId }] } = await pool.query(
        "INSERT INTO users (id, username, has_platform_access) VALUES (102, 'hal', TRUE) RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')",
        [fresh.link.id, queuedId]);
      await pool.query('UPDATE community_invites SET uses = 1 WHERE id = $1', [fresh.link.id]);
      assert.equal((await invites.redeem(pool, { token: fresh.link.token, user: as(joinedId, 'hal', true) })).status, 'joined');
      let listed = (await links()).find((l) => l.id === fresh.link.id);
      assert.deepEqual({ waiting: listed.waiting, joined: listed.joined, status: listed.status },
        { waiting: 1, joined: 1, status: 'live' }, 'the queued one waits, the joined one counts');
      // An expired link made this week is still listed, after the live ones,
      // with the people it queued still waiting on it (they are applied when
      // they are let in).
      const expired = await invites.createInvite(pool, { app: arena, user: ADA, days: 7, maxUses: 25 });
      const { rows: [{ id: expQueued }] } = await pool.query("INSERT INTO users (id, username) VALUES (103, 'omar') RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')",
        [expired.link.id, expQueued]);
      await pool.query("UPDATE community_invites SET expires_at = NOW() - INTERVAL '1 day', uses = 1 WHERE id = $1",
        [expired.link.id]);
      // A turned-off link keeps no waiting people: revoking cancels them.
      const turnedOff = await invites.createInvite(pool, { app: arena, user: ADA, days: 7, maxUses: 25 });
      const { rows: [{ id: offQueued }] } = await pool.query("INSERT INTO users (id, username) VALUES (104, 'peri') RETURNING id");
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')",
        [turnedOff.link.id, offQueued]);
      await pool.query('UPDATE community_invites SET uses = 1 WHERE id = $1', [turnedOff.link.id]);
      await invites.revokeInvite(pool, { inviteId: turnedOff.link.id, user: ADA });
      listed = await links();
      const expiredRow = listed.find((l) => l.id === expired.link.id);
      const offRow = listed.find((l) => l.id === turnedOff.link.id);
      assert.deepEqual({ waiting: expiredRow.waiting, joined: expiredRow.joined, status: expiredRow.status },
        { waiting: 1, joined: 0, status: 'expired' });
      assert.deepEqual({ waiting: offRow.waiting, joined: offRow.joined, status: offRow.status },
        { waiting: 0, joined: 0, status: 'revoked' });
      // Live rows come first, ended ones after them.
      const firstEnded = listed.findIndex((l) => l.status !== 'live');
      assert.ok(firstEnded > 0, 'the list has live rows before the ended ones');
      assert.equal(listed.slice(firstEnded).every((l) => l.status !== 'live'), true);
      // A link that ended more than 30 days ago is not listed, whatever the
      // pane's maker holds. The keep window runs from when it ended, each
      // link by its own clock, so it is its end that must age out.
      const old = await invites.createInvite(pool, { app: arena, user: ADA, days: 7, maxUses: 25 });
      await pool.query(
        "UPDATE community_invites SET created_at = NOW() - INTERVAL '32 days', expires_at = NOW() - INTERVAL '31 days' WHERE id = $1",
        [old.link.id]);
      assert.equal((await links()).some((l) => l.id === old.link.id), false, 'an old ended link is not listed');
    });

    await t.test('15 Oct 2026: the hub\'s summary and the list\'s "Invite link out" read the live links as listInvites does', async () => {
      const arena = await app('arena');
      const { links } = await invites.listInvites(pool, { app: arena, user: ADA });
      const live = links.filter((l) => l.status === 'live');
      assert.ok(live.length > 0 && links.length > live.length, 'live links and ended ones both');
      const summary = await invites.inviteSummary(pool, { app: arena, user: ADA });
      assert.deepEqual(summary, invites.summarizeLinks(links), 'the same links, summed');
      assert.equal(summary.links, live.length);
      assert.equal(summary.joined, live.reduce((n, l) => n + l.joined, 0));
      assert.equal(summary.waiting, live.reduce((n, l) => n + l.waiting, 0));
      const ends = live.map((l) => l.expiresAt).filter(Boolean).map(Date.parse);
      assert.equal(summary.expires_at, ends.length ? new Date(Math.min(...ends)).toISOString() : null, 'the soonest end');
      assert.equal(await invites.inviteSummary(pool, { app: arena, user: null }), null, 'nobody signed in: none');
      // The Communities list's read: one query for many projects, the
      // viewer's own live links and who joined through them.
      const out = await invites.linksOutFor(pool, [arena.id, 999999], ADA.id);
      const mine = live.filter((l) => l.mine);
      assert.deepEqual(out.get(arena.id), { links: mine.length, joined: mine.reduce((n, l) => n + l.joined, 0) });
      assert.equal(out.has(999999), false, 'no links, no entry');
      assert.equal((await invites.linksOutFor(pool, [arena.id], 999)).size, 0, 'somebody with no links of their own');
      assert.equal((await invites.linksOutFor(pool, [], ADA.id)).size, 0);
    });

    await t.test('WP-D: a project with no shot yet shows the card of its idea through a live link, and only then', async () => {
      const arena = await app('arena');
      const made = await invites.createInvite(pool, { app: arena, user: ADA, days: 0, maxUses: 0 });
      assert.equal((await invites.preview(pool, made.link.token)).project.picture, null);
      await pool.query(`INSERT INTO app_sketches (app_id, status, created_at) VALUES (1, 'pending', NOW())`);
      assert.equal((await invites.preview(pool, made.link.token)).project.picture, null, 'one being made is not shown');
      // A screen mock from before the card is not shown either.
      await pool.query(`UPDATE app_sketches SET status = 'ready', design = $1, html = $2 WHERE app_id = 1`,
        [JSON.stringify({ job: 'Run the arena' }), '<h1 class="text-title">Arena</h1>']);
      assert.equal((await invites.preview(pool, made.link.token)).project.picture, null, 'a screen mock is not the card');
      const card = { kind: 'card', emoji: '🎲', tagline: 'Game night for the arena', points: ['Pick the game', 'See who is in'], source: 'model' };
      await pool.query(`UPDATE app_sketches SET design = $1, html = NULL WHERE app_id = 1`, [JSON.stringify(card)]);
      const preview = await invites.preview(pool, made.link.token);
      assert.deepEqual(preview.project.picture, {
        kind: 'sketch', url: null, darkUrl: null,
        card: { emoji: '🎲', tagline: 'Game night for the arena', points: ['Pick the game', 'See who is in'] },
      });
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      assert.equal((await invites.preview(pool, made.link.token)).project, undefined, 'a dead link shows nothing');
    });

    await t.test('#4780: the list says who came in through each link, and keeps the ones that ended for 30 days', async () => {
      const arena = await app('arena');
      // One person with access (joined) and one still waiting to get in, on
      // a fresh link: the counts read off the real redemptions. A redemption
      // that waits is one the link could not grant at the time (a private
      // member without the phone it needs, say): rin's is inserted as such,
      // its use spent, the way an earlier link's would have left it.
      await pool.query(`INSERT INTO users (id, username, has_platform_access) VALUES (31, 'pia', TRUE), (32, 'rin', FALSE)`);
      const made = await invites.createInvite(pool, { app: arena, user: ADA, maxUses: 25 });
      assert.equal((await invites.redeem(pool, { token: made.link.token, user: as(31, 'pia', true) })).status, 'joined');
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, 32, 'queued')", [made.link.id]);
      await pool.query('UPDATE community_invites SET uses = 2 WHERE id = $1', [made.link.id]);
      const listed = (await invites.listInvites(pool, { app: arena, user: ADA })).links.find((l) => l.id === made.link.id);
      assert.deepEqual([listed.status, listed.joined, listed.waiting], ['live', 1, 1]);
      // A cancelled redemption counts as neither joined nor waiting.
      await pool.query(
        "INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, 5, 'cancelled')", [made.link.id]);
      const withCancelled = (await invites.listInvites(pool, { app: arena, user: ADA })).links.find((l) => l.id === made.link.id);
      assert.deepEqual([withCancelled.joined, withCancelled.waiting], [1, 1], 'cancelled counts as neither');

      // Turned off: still listed, as revoked, with nobody waiting (its queued
      // redemptions were cancelled with it).
      await invites.revokeInvite(pool, { inviteId: made.link.id, user: ADA });
      const off = (await invites.listInvites(pool, { app: arena, user: ADA })).links.find((l) => l.id === made.link.id);
      assert.deepEqual([off.status, off.joined, off.waiting], ['revoked', 1, 0]);

      // Expired, and past the keep window: gone from the list. Recent: kept.
      const old = await invites.createInvite(pool, { app: arena, user: ADA });
      await pool.query("UPDATE community_invites SET expires_at = NOW() - INTERVAL '31 days' WHERE id = $1", [old.link.id]);
      let ids = (await invites.listInvites(pool, { app: arena, user: ADA })).links.map((l) => l.id);
      assert.equal(ids.includes(old.link.id), false, 'an ended link from more than 30 days back is not listed');
      await pool.query("UPDATE community_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [old.link.id]);
      const recent = (await invites.listInvites(pool, { app: arena, user: ADA })).links.find((l) => l.id === old.link.id);
      assert.equal(recent.status, 'expired');

      // Used up, ended within the window (its latest redemption is recent).
      const full = await invites.createInvite(pool, { app: arena, user: ADA, maxUses: 1 });
      assert.equal((await invites.redeem(pool, { token: full.link.token, user: as(4, 'dee', true) })).status, 'joined');
      const spent = (await invites.listInvites(pool, { app: arena, user: ADA })).links.find((l) => l.id === full.link.id);
      assert.deepEqual([spent.status, spent.joined, spent.waiting], ['used_up', 1, 0]);

      // Live links sort before ended ones.
      const fresh = (await invites.createInvite(pool, { app: arena, user: ADA })).link;
      ids = (await invites.listInvites(pool, { app: arena, user: ADA })).links.map((l) => l.id);
      assert.ok(ids.indexOf(fresh.id) < ids.indexOf(recent.id), 'live before ended');
      assert.ok(ids.indexOf(fresh.id) < ids.indexOf(full.link.id), 'live before used up');
    });

    await t.test('WP-D: what joining means, said from the project\'s real rule', async () => {
      const governance = require('../src/services/governance');
      // The default rule is said for the vote's own headcount
      // (active-users.js getActiveUserStats), which reads tables this scratch
      // schema does not carry: it is stood in for here, and read for real in
      // tests/username-invite-join-postgres.test.js. The invites still
      // waiting are counted from app_collaborators, which is here.
      const votes = require('../src/services/active-users');
      const realStats = votes.getActiveUserStats;
      let active = 1;
      votes.getActiveUserStats = async () => ({ active, majority: Math.floor(active / 2) + 1 });
      const rule = async (patch = {}) => {
        await pool.query(`UPDATE apps SET approver_policy = $1, approvals_required = $2, locked = $3 WHERE id = 1`,
          [patch.policy || 'anyone', patch.n ?? null, !!patch.locked]);
        governance.invalidateGovernance(1);
        return invites.joiningRule(pool, { ...(await app('arena')), locked: !!patch.locked });
      };
      try {
        assert.equal(await rule(), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer.');
        assert.equal(await rule({ locked: true }), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer. An admin has to say yes too.');
        assert.equal(await rule({ n: 2 }), 'A change goes live once it has 2 yes votes.');
        assert.equal(await rule({ n: 1, policy: 'invited' }), 'A change goes live once it has a yes from its approvers.');
        assert.equal(await rule({ policy: 'invited' }), 'A change goes live once its approvers back it.');
        // First-session run-through, 5 October 2026: the people in it, and
        // the invites by username still waiting, are counted.
        active = 2;
        assert.equal(await rule(), 'With one other person using it, a change goes live when you both say yes, '
          + 'or 3 days after one of you says yes if the other doesn\'t answer.', 'two: the one other person is in it');
        await pool.query("INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES (1, 4, 'invited', 1)");
        assert.equal(await rule(), 'With 3 people in it, counting 1 invited, a change goes live when 2 of you say yes, '
          + 'or 3 days after the first yes if nobody says no.');
        await pool.query('DELETE FROM app_collaborators WHERE app_id = 1 AND user_id = 4');
        active = 6;
        assert.equal(await rule(), 'With 6 people using it, a change goes live when 3 of you say yes, '
          + 'or 5 days after the first yes if nobody says no.');
        assert.equal(await rule({ locked: true }), 'With 6 people using it, a change goes live when 3 of you say yes, '
          + 'or 5 days after the first yes if nobody says no. An admin has to say yes too.');
      } finally {
        votes.getActiveUserStats = realStats;
        await rule();
      }
    });

    await t.test('no skips past the waitlist: anybody new joins as a private member, whoever made the link', async () => {
      const arena = await app('arena');
      const newcomer = async (name) => (await pool.query('INSERT INTO users (username) VALUES ($1) RETURNING id', [name])).rows[0].id;
      const tier = async (id) => (await pool.query(
        'SELECT has_platform_access, admitted_by, invite_generation, private_member_since IS NOT NULL AS private FROM users WHERE id = $1',
        [id])).rows[0];
      // cy was let off the waitlist by hand (generation 0: the tree's ten
      // skips once), and root is an admin (the tree's unlimited ones).
      const CY = as(3, 'cy', true);
      const ROOT = { id: 9, username: 'root', isAdmin: true, hasPlatformAccess: true };
      for (const [maker, name] of [[CY, 'nia'], [ROOT, 'ola'], [ADA, 'pia']]) {
        const link = (await invites.createInvite(pool, { app: arena, user: maker })).link;
        const id = await newcomer(name);
        const joined = await invites.redeem(pool, { token: link.token, user: as(id, name, false) });
        assert.deepEqual([joined.status, joined.slug, joined.privateMember], ['joined', 'arena', true], `${maker.username}'s link`);
        assert.equal('skippedWaitlist' in joined, false);
        assert.deepEqual(await tier(id), { has_platform_access: false, admitted_by: null, invite_generation: null, private: true },
          `${name} waits for the waitlist like anybody else`);
      }
      // Letting one in is the waitlist's own release.
      const { rows: [{ id: nia }] } = await pool.query("SELECT id FROM users WHERE username = 'nia'");
      await waitlist.grantPlatformAccess(pool, nia, { manualRelease: true });
      assert.equal((await tier(nia)).has_platform_access, true);
    });
  } finally {
    await dropSchema(pool);
  }
});
