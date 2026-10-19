'use strict';

// #5104: teen-safe defaults for everyone, against the full schema:
//
//   - every account, existing ones included, starts with contact_policy
//     'shared' and profile_discoverable FALSE, and only its owner loosens
//     them (services/contact-privacy.js);
//   - starting something NEW with a person (a direct message, a group chat
//     invitation, adding them to a group, a friend request, a project or
//     approver invite) needs a shared project community or a friendship,
//     unless they chose "Anyone". Homeroom's own community connects nobody.
//     A conversation that already exists keeps working, answering their own
//     request is never refused, and the Homeroom bot is never held to it;
//   - the refusal is a 403 with code contact_restricted and nothing about
//     the person, through the real route;
//   - a search (the directory every surface reads, the Messages picker, a
//     channel's @ list) finds a person who keeps their profile out of it
//     only for people connected to them, and the Messages picker still
//     resolves a whole handle typed out.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests; required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

let routePool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => routePool;

const conversations = require('../src/services/conversations');
const friends = require('../src/services/friends');
const contactPrivacy = require('../src/services/contact-privacy');
const userDirectory = require('../src/services/user-directory');
const collabInvites = require('../src/services/collab-invites');
const emailInvites = require('../src/services/email-invites');
const approverInvites = require('../src/services/approver-invites');
const appManifest = require('../src/services/app-manifest');
const { conversationRoutes } = require('../src/routes/conversations');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `contact_privacy_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  return pool;
}

test('who can reach you and who can find you (#5104)', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  routePool = pool;

  async function user(name, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [name, synthetic]
    );
    return rows[0];
  }
  async function makeLink(app, maker) {
    const communityId = (await pool.query('SELECT community_id FROM apps WHERE id = $1', [app.id])).rows[0].community_id;
    return (await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days') RETURNING id`,
      [crypto.randomBytes(12).toString('hex'), communityId, app.id, maker.id]
    )).rows[0].id;
  }
  async function redeem(inviteId, person) {
    const redemption = (await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id) VALUES ($1, $2) RETURNING id`,
      [inviteId, person.id]
    )).rows[0];
    return (await pool.query('SELECT apply_community_invite($1) AS ok', [redemption.id])).rows[0].ok;
  }
  async function project(slug, owner, members) {
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, 'private', 'private')`,
      [slug, owner.id]
    );
    // The community is minted by an AFTER trigger, so RETURNING cannot see it.
    const { rows } = await pool.query(
      'SELECT id, slug, community_id, self_hosted, collab_visibility FROM apps WHERE slug = $1', [slug]
    );
    // The creator's own row, as POST /api/apps writes it: no inviter.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [rows[0].id, owner.id]
    );
    // Each member came in by an invitation the owner sent and they accepted,
    // the way collab-invites.js writes it; the collaborator trigger joins
    // them to the community.
    for (const person of members) {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at, accepted_via)
         VALUES ($1, $2, 'member', $3, NOW(), 'invite')`,
        [rows[0].id, person.id, owner.id]
      );
    }
    return rows[0];
  }

  const alice = await user('alice');
  const bob = await user('bob'); // in a project with alice
  const carol = await user('carol'); // a stranger to alice
  const dana = await user('dana'); // a stranger who chose Anyone
  const frank = await user('frank'); // alice's friend, no shared project
  const grace = await user('grace'); // stranger, alice is the one asked
  const bot = await user('homeroom_bot_test', { synthetic: true });

  // Homeroom's own community: every account is in it, and it connects nobody.
  await pool.query(
    `INSERT INTO apps (name, slug, created_by, self_hosted) VALUES ('Homeroom', 'homeroom', $1, TRUE)`, [alice.id]
  );
  const homeroom = (await pool.query(`SELECT id, community_id FROM apps WHERE slug = 'homeroom'`)).rows[0];
  for (const person of [alice, bob, carol, dana, frank, grace]) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'auto')
       ON CONFLICT DO NOTHING`, [homeroom.community_id, person.id]
    );
  }
  const club = await project('book-club', alice, [bob]);
  await pool.query(`UPDATE users SET contact_policy = 'anyone' WHERE id = $1`, [dana.id]);
  await pool.query(
    `INSERT INTO friendships (user_low_id, user_high_id, requester_id, status, responded_at)
     VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int), $1, 'accepted', NOW())`,
    [alice.id, frank.id]
  );

  await t.test('every account starts safe, and only parseUpdate-shaped changes save', async () => {
    assert.deepEqual(await contactPrivacy.readSettings(pool, carol.id), { whoCanContact: 'shared', discoverable: false });
    const columns = (await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('contact_policy', 'profile_discoverable')
        ORDER BY column_name`
    )).rows;
    assert.match(columns[0].column_default, /'shared'/);
    assert.equal(columns[1].column_default, 'false');
    await assert.rejects(pool.query(`UPDATE users SET contact_policy = 'everyone' WHERE id = $1`, [carol.id]));
    assert.equal(contactPrivacy.parseUpdate({}).ok, false);
    assert.equal(contactPrivacy.parseUpdate({ whoCanContact: 'everyone' }).ok, false);
    assert.equal(contactPrivacy.parseUpdate({ discoverable: 'yes' }).ok, false);
    const parsed = contactPrivacy.parseUpdate({ discoverable: true });
    assert.deepEqual(await contactPrivacy.saveSettings(pool, grace.id, parsed.value), { whoCanContact: 'shared', discoverable: true });
    assert.deepEqual(await contactPrivacy.saveSettings(pool, grace.id, { discoverable: false }), { whoCanContact: 'shared', discoverable: false });
  });

  await t.test('connected means a project community or a friendship, never Homeroom itself', async () => {
    const connected = async (a, b) => (await pool.query('SELECT users_connected($1, $2) AS v', [a.id, b.id])).rows[0].v;
    assert.equal(await connected(alice, bob), true);
    assert.equal(await connected(bob, alice), true);
    assert.equal(await connected(alice, frank), true);
    assert.equal(await connected(alice, carol), false, 'Homeroom\'s own community connects nobody');
    assert.equal(await contactPrivacy.mayContact(pool, carol.id, dana.id), true, 'Anyone');
    assert.equal(await contactPrivacy.mayContact(pool, carol.id, bot.id), true, 'a person can always write to the bot');
    assert.equal(await contactPrivacy.mayContact(pool, bot.id, carol.id), true, 'the bot is never held to it');
    assert.deepEqual(await contactPrivacy.restrictedAmong(pool, alice.id, [bob.id, carol.id, dana.id, frank.id]), [carol.id]);
  });

  await t.test('only ties both people chose connect them', async () => {
    const connected = async (a, b) => (await pool.query('SELECT users_connected($1, $2) AS v', [a.id, b.id])).rows[0].v;
    const henry = await user('henry');
    const ivy = await user('ivy');
    const jack = await user('jack');
    const join = async (app, person) => pool.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
       ON CONFLICT DO NOTHING`, [app.community_id, person.id]
    );
    const appRow = async (slug) => (await pool.query(
      'SELECT id, slug, community_id, view_visibility FROM apps WHERE slug = $1', [slug]
    )).rows[0];

    // A public project ivy joined: henry joining it too connects him to nobody.
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('square', 'square', $1, 'public', 'private')`, [jack.id]
    );
    const square = await appRow('square');
    await join(square, ivy);
    await join(square, henry);
    assert.equal(await connected(henry, ivy), false, 'joining a public community she is in does not connect him');
    await assert.rejects(conversations.createDirect(pool, henry, ivy.id), contactPrivacy.ContactRestrictedError);
    await assert.rejects(
      friends.sendRequest(pool, henry, ivy.id),
      (err) => err instanceof friends.FriendsError && err.code === 'contact_restricted'
    );
    assert.deepEqual((await userDirectory.searchPrefix(pool, 'iv', 10, { viewerId: henry.id })).users, []);

    // ...and when the project goes private later, those self-service joins
    // still connect nobody.
    await pool.query(`UPDATE apps SET view_visibility = 'private' WHERE id = $1`, [square.id]);
    assert.equal(await connected(henry, ivy), false, 'a member who joined while it was public');
    assert.equal(await connected(jack, ivy), false, 'nor the creator to somebody who only joined');

    // An invitation she accepted connects ivy to the project's creator.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at, accepted_via)
       VALUES ($1, $2, 'member', $3, NOW(), 'invite')`, [square.id, ivy.id, jack.id]
    );
    assert.equal(await connected(jack, ivy), true, 'an accepted collaborator and the creator');
    assert.equal(await connected(henry, ivy), false, 'still not the member who only joined');

    // A stranger names ivy an admin in his own project's dapp.json:
    // applyAdminsChange writes app_admins and a collaborator row with no
    // inviter and no asking. That connects nobody.
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('lair', 'lair', $1, 'private', 'private')`, [henry.id]
    );
    const lair = await appRow('lair');
    await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [lair.id, ivy.id]);
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [lair.id, ivy.id]
    );
    assert.equal(await connected(henry, ivy), false, 'a declared admin who never accepted');
    await assert.rejects(conversations.createDirect(pool, henry, ivy.id), contactPrivacy.ContactRestrictedError);

    // An invite link into a private community (the maker's collaborator
    // invite, accepted by redeeming it) connects the joiner to its creator.
    const kate = await user('kate');
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('reading', 'reading', $1, 'private', 'private')`, [jack.id]
    );
    const reading = await appRow('reading');
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())`,
      [reading.id, jack.id]
    );
    assert.equal(await redeem(await makeLink(reading, jack), kate), true);
    assert.equal(await connected(jack, kate), true, 'an invite-link joiner of a private community');
    // Members of a private community who both came in by invitation.
    assert.equal(await connected(alice, bob), true);

    // A link redeemed into a community while it was PUBLIC (building open,
    // so the link is membership only) connects nobody once it goes private.
    const lia = await user('lia');
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('plaza', 'plaza', $1, 'public', 'public')`, [jack.id]
    );
    const plaza = await appRow('plaza');
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'creator')
       ON CONFLICT DO NOTHING`, [plaza.community_id, jack.id]
    );
    const plazaLink = await makeLink(plaza, jack);
    assert.equal(await redeem(plazaLink, lia), true);
    await pool.query(
      `UPDATE apps SET view_visibility = 'private', collab_visibility = 'private' WHERE id = $1`, [plaza.id]
    );
    assert.equal(await connected(jack, lia), false, 'a link redeemed while the community was public');
  });

  await t.test('an acceptance counts only when the person accepted, from someone in by consent', async () => {
    const connected = async (a, b) => (await pool.query('SELECT users_connected($1, $2) AS v', [a.id, b.id])).rows[0].v;
    const owner = await user('olga');
    const mia = await user('mia');
    const ned = await user('ned');
    const forge = await project('forge', owner, []);

    // A pending invite to mia, then the project's dapp.json names her an
    // admin: applyAdminsChange makes the row a member, which she never
    // accepted, so it connects her to nobody.
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by) VALUES ($1, $2, 'invited', $3)`,
      [forge.id, mia.id, owner.id]
    );
    await appManifest.applyAdminsChange(pool, { id: forge.id, slug: forge.slug, admin_usernames: [] },
      { usernames: ['mia'], userIds: [mia.id] });
    const miaRow = (await pool.query(
      'SELECT status, accepted_at, accepted_via FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
      [forge.id, mia.id]
    )).rows[0];
    assert.equal(miaRow.status, 'member');
    assert.equal(miaRow.accepted_at, null, 'no acceptance is recorded for her');
    assert.equal(miaRow.accepted_via, null);
    assert.equal(await connected(owner, mia), false, 'a pending invite turned into a membership by dapp.json');

    // mia, a member nobody asked, makes an invite link and ned redeems it:
    // the link's maker is not in the project by consent, so ned's place
    // there connects him to nobody, the creator included.
    const link = await makeLink(forge, mia);
    assert.equal(await redeem(link, ned), true);
    assert.equal((await pool.query(
      'SELECT accepted_via FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [forge.id, ned.id]
    )).rows[0].accepted_via, 'link');
    assert.equal(await connected(owner, ned), false, 'a link from a member who never accepted');

    // The same link made by the creator connects its joiner.
    const pia = await user('pia');
    assert.equal(await redeem(await makeLink(forge, owner), pia), true);
    assert.equal(await connected(owner, pia), true, 'a link from the creator');
    // And accepting an invitation through the real path records it.
    const quin = await user('quin');
    assert.equal((await collabInvites.sendInvite(pool, { app: forge, target: quin, inviterId: owner.id })).ok, false,
      'a stranger to her, until she takes invitations from anyone');
    await pool.query(`UPDATE users SET contact_policy = 'anyone' WHERE id = $1`, [quin.id]);
    assert.equal((await collabInvites.sendInvite(pool, { app: forge, target: quin, inviterId: owner.id })).ok, true);
    assert.equal((await collabInvites.acceptInvite(pool, { appId: forge.id, user: quin })).ok, true);
    assert.equal(await connected(owner, quin), true, 'an accepted invitation');
    assert.equal(await connected(pia, quin), true, 'two people who both accepted');
  });

  await t.test('a new direct message, group or invitation waits on contact_policy', async () => {
    await assert.rejects(conversations.createDirect(pool, alice, carol.id), contactPrivacy.ContactRestrictedError);
    assert.ok((await conversations.createDirect(pool, alice, bob.id)).conversationId, 'a project member');
    assert.ok((await conversations.createDirect(pool, alice, frank.id)).conversationId, 'a friend');
    assert.ok((await conversations.createDirect(pool, carol, dana.id)).conversationId, 'someone who chose Anyone');
    assert.ok((await conversations.createDirect(pool, carol, bot.id)).conversationId, 'the bot');

    await assert.rejects(conversations.createGroup(pool, alice, 'Plans', [bob.id, carol.id]), contactPrivacy.ContactRestrictedError);
    const group = await conversations.createGroup(pool, alice, 'Plans', [bob.id, frank.id]);
    assert.ok(group.conversationId);
    await assert.rejects(conversations.addMembers(pool, alice, group.conversationId, [carol.id]), contactPrivacy.ContactRestrictedError);
    assert.ok(await conversations.addMembers(pool, alice, group.conversationId, [dana.id]));

    const sent = await collabInvites.sendInvite(pool, { app: club, target: carol, inviterId: alice.id });
    assert.deepEqual(sent, { ok: false, status: 'contact_restricted' });
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS n FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [club.id, carol.id]
    )).rows[0].n, 0, 'no pending row');

    // An invite sent to an address before it had an account is held to the
    // account's setting when the address is confirmed: a stranger's is
    // dropped without an error, a connected person's is applied.
    const kim = await user('kim');
    await pool.query(
      `INSERT INTO app_email_invites (app_id, email, invited_by) VALUES ($1, 'kim@example.test', $2)`,
      [club.id, carol.id]
    );
    const garden = await project('garden', bob, []);
    await pool.query(
      `INSERT INTO friendships (user_low_id, user_high_id, requester_id, status, responded_at)
       VALUES (LEAST($1::int, $2::int), GREATEST($1::int, $2::int), $1, 'accepted', NOW())`,
      [bob.id, kim.id]
    );
    await pool.query(
      `INSERT INTO app_email_invites (app_id, email, invited_by) VALUES ($1, 'kim@example.test', $2)`,
      [garden.id, bob.id]
    );
    assert.equal(await emailInvites.claimEmailInvites(pool, { userId: kim.id, email: 'kim@example.test' }), 1);
    const kimRows = (await pool.query(
      'SELECT app_id, status FROM app_collaborators WHERE user_id = $1 ORDER BY app_id', [kim.id]
    )).rows;
    assert.ok(!kimRows.some((row) => row.app_id === club.id), 'the stranger\'s invite was dropped');
    assert.ok(kimRows.some((row) => row.app_id === garden.id && row.status === 'invited'), 'the connected person\'s applied');

    const town = (await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ('town', 'town', $1, 'public', 'public') RETURNING id, slug, self_hosted, collab_visibility`, [alice.id]
    )).rows[0];
    await assert.rejects(
      approverInvites.inviteApprover(pool, town, 'grace', alice),
      (err) => err instanceof approverInvites.ApproverInviteError && err.status === 403
    );

    await assert.rejects(
      friends.sendRequest(pool, alice, grace.id),
      (err) => err instanceof friends.FriendsError && err.status === 403 && err.code === 'contact_restricted'
    );
  });

  await t.test('what already exists keeps working, and answering their own request is consent', async () => {
    // Carol chooses Anyone, Grace writes to her, then Carol tightens it again.
    await contactPrivacy.saveSettings(pool, carol.id, { whoCanContact: 'anyone' });
    const dm = await conversations.createDirect(pool, grace, carol.id);
    await contactPrivacy.saveSettings(pool, carol.id, { whoCanContact: 'shared' });
    // Carol accepting Grace's request, and Grace's chat once open, still work.
    const reply = await conversations.createDirect(pool, carol, grace.id);
    assert.equal(reply.conversationId, dm.conversationId, 'a reciprocal request accepts the pending one');
    const again = await conversations.createDirect(pool, grace, carol.id);
    assert.equal(again.conversationId, dm.conversationId, 'the open chat answers, not a refusal');
    const message = await conversations.sendMessage(pool, grace, dm.conversationId, { content: 'still here' });
    assert.ok(message, 'sending into an existing conversation is not gated');

    // A friend request Grace sent while Dana took them from anyone is answered
    // by Dana, whatever Grace's own setting is.
    await friends.sendRequest(pool, grace, dana.id);
    assert.equal((await friends.sendRequest(pool, dana, grace.id)).state, 'friends');
  });

  await t.test('the route answers 403 contact_restricted and nothing about the person', async () => {
    const app = express();
    app.use(express.json());
    let actor = alice;
    app.use((req, _res, next) => { req.user = { id: actor.id, username: actor.username, isAdmin: false }; next(); });
    app.use(conversationRoutes({}));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => server.close());
    const post = async (as, url, body) => {
      actor = as;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const refused = await post(bob, '/api/conversations', { kind: 'direct', user_id: grace.id });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, contactPrivacy.CONTACT_RESTRICTED);
    assert.equal(Object.keys(refused.body).sort().join(','), 'code,error');
    const group = await post(bob, '/api/conversations', { kind: 'group', title: 'Hi', member_ids: [grace.id] });
    assert.equal(group.status, 403);
    assert.equal(group.body.code, 'contact_restricted');
    const ok = await post(bob, '/api/conversations', { kind: 'group', title: 'Hi', member_ids: [alice.id] });
    assert.equal(ok.status, 201);
    const add = await post(bob, `/api/conversations/${ok.body.conversation.id}/members`, { user_ids: [grace.id] });
    assert.equal(add.status, 403);
    assert.equal(add.body.code, 'contact_restricted');
  });

  await t.test('a search finds people who opted in, and people connected to the viewer', async () => {
    const found = async (viewer, q) => (await userDirectory.searchPrefix(pool, q, 25, { viewerId: viewer ? viewer.id : null }))
      .users.map((u) => u.username).sort();
    // grace is discoverable to nobody but her connections; dana is a friend of grace now.
    assert.deepEqual(await found(bob, 'gra'), []);
    assert.deepEqual(await found(dana, 'gra'), ['grace'], 'a friend finds her');
    assert.deepEqual(await found(alice, 'b'), ['bob'], 'a project member finds bob');
    assert.deepEqual(await found(carol, 'b'), [], 'a stranger does not');
    assert.deepEqual(await found(null, 'b'), [], 'no viewer finds only people who opted in');
    await contactPrivacy.saveSettings(pool, bob.id, { discoverable: true });
    assert.deepEqual(await found(carol, 'b'), ['bob'], 'once bob opts in, anyone finds him');
    assert.deepEqual(await found(null, 'b'), ['bob']);
    await contactPrivacy.saveSettings(pool, bob.id, { discoverable: false });
    assert.deepEqual(await found(alice, 'ali'), ['alice'], 'you always find yourself');
    // An exact lookup is a handle the caller already knows, like a profile link.
    assert.equal((await userDirectory.lookupExact(pool, 'grace')).found, true);
  });

  await t.test("a channel's @ list leaves out quiet people the viewer cannot find", async () => {
    const general = (await pool.query(
      `SELECT id FROM conversations WHERE kind = 'channel' AND channel_key = 'general'`
    )).rows[0].id;
    for (const person of [alice, bob, carol, grace]) await conversations.ensureChannelMemberships(pool, person);
    const names = async (viewer, q) => (await conversations.mentionCandidates(pool, viewer, general, { q }))
      .map((u) => u.username).sort();
    assert.deepEqual(await names(carol, 'b'), [], 'bob has not spoken and carol is not connected to him');
    assert.deepEqual(await names(alice, 'b'), ['bob'], 'alice is in a project with bob');
    await conversations.sendMessage(pool, bob, general, { content: 'hello all' });
    assert.deepEqual(await names(carol, 'b'), ['bob'], 'once he speaks there, his name is on screen anyway');
    // A group chat's members already see each other: no filter there.
    const group = await conversations.createGroup(pool, alice, 'Pair', [bob.id]);
    await conversations.respond(pool, bob, group.conversationId, 'accept');
    assert.deepEqual(
      (await conversations.mentionCandidates(pool, bob, group.conversationId, { q: 'a' })).map((u) => u.username),
      ['alice']
    );
  });
});
