'use strict';

/**
 * Sending a collaborator invite: the pending `app_collaborators` row, the
 * invitee's notification pushed live, and the analytics event. Two callers
 * send one: POST /api/apps/:slug/invites (routes/collaborators.js), one at a
 * time from Members & approvals, and POST /api/apps (routes/apps.js), for the
 * people a Group is created with (communities, stage 3). One function, so an
 * invite sent at creation is the same invite, with the same notification the
 * invitee accepts or declines, as one sent from the project's page.
 *
 * A pending invite grants nothing: accepting it (routes/collaborators.js)
 * makes the row a `member`, and that is what joins the project's community
 * (the collaborator trigger in src/db/schema.sql). The pending row already
 * makes the project read as a Group (communities.audienceSql).
 *
 * ── Joining, or building ────────────────────────────────────────────────
 *
 * On a project only its people can see (a Group, or Just you becoming one)
 * this invite IS how somebody joins: being a collaborator is what being in a
 * private project is, which is why an invite link there is this same grant
 * (community-invites.js grantFor). So it is worded as an invitation to join
 * (`detail: 'join'` on its notification, `joins` on the pending invite), and
 * carries the inviter's note the way a link does. Only on a project anyone
 * can use but only its invited people build is it an invitation to build.
 * Accepting one that joined them answers with what the link path's "You're
 * in" needs (welcomeFor), so the two ways in end on the same welcome.
 */

const log = require('./logger');
const notifications = require('./notifications');
const events = require('./events');
const appAccess = require('./app-access');
const contactPrivacy = require('./contact-privacy');

// Hydrate freshly inserted notification rows into the serialize() wire shape
// (the column set listForUser produces) and push them live.
async function hydrateAndPush(pool, notifRows) {
  if (!notifRows.length) return;
  const { rows: hydrated } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id, NULL AS message_content,
            n.session_id, NULL AS pr_title, NULL AS pr_number,
            su.username AS source_username, n.user_id, n.detail
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN users su ON su.id = n.source_user_id
      WHERE n.id = ANY($1::int[])`,
    [notifRows.map((r) => r.id)]
  );
  const { pushNotificationToUser } = require('./ws');
  for (const row of hydrated) {
    pushNotificationToUser(row.user_id, {
      type: 'notification_new',
      notification: notifications.serialize(row),
    });
  }
}

/**
 * Invite `target` ({ id, username }) into `app` ({ id, slug }) on behalf of
 * `inviterId`, with their `note` (already cleaned: community-invites.js
 * cleanNote; null for none). Returns `{ ok: true }`, or `{ ok: false,
 * status }` when a row already existed (`status` is that row's: 'member' or
 * 'invited'). The notification and the event are best-effort; the row is not.
 *
 * #5104: `{ ok: false, status: 'contact_restricted' }` when `target` takes
 * invitations only from people connected to them (users.contact_policy) and
 * the inviter is not. Every caller is held to it, an invite by email claimed
 * when its address is confirmed included (services/email-invites.js).
 */
async function sendInvite(pool, { app, target, inviterId, note = null }) {
  if (!(await contactPrivacy.mayContact(pool, inviterId, target.id))) {
    return { ok: false, status: contactPrivacy.CONTACT_RESTRICTED_CODE };
  }
  const { rows: inserted } = await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, invite_note)
     VALUES ($1, $2, 'invited', $3, $4)
     ON CONFLICT (app_id, user_id) DO NOTHING
     RETURNING user_id`,
    [app.id, target.id, inviterId, note || null]
  );
  if (!inserted.length) {
    const { rows: existing } = await pool.query(
      'SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
      [app.id, target.id]
    );
    return { ok: false, status: existing[0]?.status || null };
  }

  // Badge bump + drawer history row, pushed live.
  try {
    const notifRows = await notifications.createCollabInviteNotification(pool, {
      appId: app.id,
      recipientId: target.id,
      inviterId,
      detail: await invitesToJoin(pool, app) ? JOIN_DETAIL : null,
    });
    await hydrateAndPush(pool, notifRows);
  } catch (err) {
    log.warn('collab', 'invite notify failed', { err: err.message });
  }

  events.record(pool, {
    type: events.EVENT_TYPES.COLLAB_INVITED,
    userId: inviterId,
    appId: app.id,
    metadata: { invitedUserId: target.id },
  });
  return { ok: true };
}

/**
 * Accept `user`'s pending invite into app `appId`. Two callers: the
 * notification's Accept (POST /api/invites/:appId/accept) and the first-run
 * join screen, where a new account ticks the group it was invited into
 * (services/onboarding.js). An invite sent by email arrives here too, once
 * the address is claimed (services/email-invites.js turns it into this
 * pending row). Idempotent: accepting when already a member is
 * `{ ok: true, alreadyMember: true }`, for two-tab races.
 *
 * Accepting pins the app to Home, as an invite link does
 * (apply_community_invite in src/db/schema.sql) and as Join does
 * (communities.join). The pin is not decoration: the daily vote digest
 * (services/vote-digest.js) finds people only through app_favorites and
 * the creator, and the per-proposal notification reads the same rows
 * beside the members active lately, so a member added by name without a
 * pin would not hear about a vote until they had been active.
 * `hidden = FALSE` clears an earlier opt-out, as the link path does. The
 * pin is written in the same transaction as the membership, so an accept
 * never lands without it; the already-member answer writes nothing, so a
 * second tab cannot undo a later opt-out.
 *
 * Returns `{ ok: true, appSlug }` or `{ ok: false, status, error }`; the
 * inviter's notification, the chat line and the event are best-effort.
 */
async function acceptInvite(pool, { appId, user }) {
  const updated = await acceptAndPin(pool, appId, user.id);

  const { rows: appRows } = await pool.query(
    'SELECT id, slug, name FROM apps WHERE id = $1', [appId]
  );
  if (!appRows.length) return { ok: false, status: 404, error: 'App not found' };
  const app = appRows[0];

  if (!updated.length) {
    // No pending invite: already a member (idempotent ok) or never
    // invited (404 — don't disclose anything else).
    const isMember = await appAccess.isCollaborator(pool, appId, user.id);
    if (isMember) return { ok: true, appSlug: app.slug, alreadyMember: true };
    return { ok: false, status: 404, error: 'Invite not found' };
  }

  await notifications.markInviteNotificationsRead(pool, user.id, appId).catch(() => {});
  appAccess.invalidateVisibility(appId, app.slug);

  const wsSvc = require('./ws');
  try { wsSvc.pushNotificationToUser(user.id, { type: 'notifications_changed' }); } catch {}

  // Tell the inviter their invite landed.
  const inviterId = updated[0].invited_by;
  if (inviterId && inviterId !== user.id) {
    try {
      const notifRows = await notifications.createCollabInviteAcceptedNotification(pool, {
        appId,
        recipientId: inviterId,
        accepterId: user.id,
      });
      await hydrateAndPush(pool, notifRows);
    } catch (err) {
      log.warn('collab', 'accept notify failed', { err: err.message });
    }
  }


  events.record(pool, {
    type: events.EVENT_TYPES.COLLAB_JOINED,
    userId: user.id,
    appId,
    metadata: { invitedBy: inviterId || null },
  });

  log.info('collab', 'Invite accepted', { appId, userId: user.id });
  return { ok: true, appSlug: app.slug };
}

// The membership and the Home pin, together or not at all. Returns the
// accepted rows (`invited_by`), empty when there was no pending invite.
async function acceptAndPin(pool, appId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE app_collaborators
          SET status = 'member', accepted_at = NOW(), accepted_via = 'invite'
        WHERE app_id = $1 AND user_id = $2 AND status = 'invited'
        RETURNING invited_by`,
      [appId, userId]
    );
    if (rows.length) {
      await client.query(
        `INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)
         ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = FALSE`,
        [appId, userId]
      );
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// What a collab_invite notification's `detail` says when the invite is to
// join the project rather than to build it (see the header).
const JOIN_DETAIL = 'join';

/**
 * Whether an invite into `app` is an invitation to join it: true unless
 * anyone can use the project (view-public), where it only lets them build.
 * Read from `app` when it carries view_visibility, else from its row.
 */
async function invitesToJoin(pool, app) {
  let view = app && app.view_visibility;
  if (view === undefined) {
    const { rows } = await pool.query('SELECT view_visibility FROM apps WHERE id = $1', [app.id]);
    view = rows[0]?.view_visibility;
  }
  return view !== 'public';
}

/**
 * What "You're in" (frontend/src/features/first-session) needs for `userId`,
 * who has just accepted an invite into app `appId`, in the shape the invite
 * link path hands it (App._followInvite): the project, who invited them and
 * whether they made it, and whether the account is about as old as this
 * accept (a test account, made ahead by an admin, is new on its first
 * sign-in instead: test-accounts.js onFirstRun). "You're in" reads who is in
 * the community itself (#4052). Null when there is no accepted row to read.
 */
async function welcomeFor(pool, { appId, userId }) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.icon_emoji, a.icon_image_id,
            (ac.invited_by IS NOT NULL AND ac.invited_by = a.created_by) AS inviter_made_it,
            inv.username AS inviter, inv.display_name AS inviter_display_name,
            COALESCE(ac.accepted_at, NOW()) AS joined_at,
            (u.created_at >= COALESCE(ac.accepted_at, NOW()) - INTERVAL '1 hour') AS new_account
       FROM apps a
       JOIN app_collaborators ac ON ac.app_id = a.id AND ac.user_id = $2 AND ac.status = 'member'
       JOIN users u ON u.id = ac.user_id
       LEFT JOIN users inv ON inv.id = ac.invited_by
      WHERE a.id = $1`,
    [appId, userId]
  );
  const row = rows[0];
  if (!row) return null;
  const communityInvites = require('./community-invites');
  const [firstRun, building] = await Promise.all([
    row.new_account ? false : require('./test-accounts').onFirstRun(pool, userId, row.joined_at),
    communityInvites.firstVersionPending(pool, row.id),
  ]);
  return {
    slug: row.slug,
    name: row.name || row.slug,
    iconEmoji: row.icon_emoji || null,
    iconUrl: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    inviter: row.inviter || null,
    inviterName: row.inviter_display_name || row.inviter || null,
    inviterMadeIt: !!row.inviter_made_it,
    // Its first version still on its way: "<maker> is making it".
    building,
    newAccount: !!row.new_account || firstRun,
  };
}

module.exports = { JOIN_DETAIL, acceptInvite, hydrateAndPush, invitesToJoin, sendInvite, welcomeFor };
