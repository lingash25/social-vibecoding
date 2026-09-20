// Collaborator membership + invites for collab-private apps, plus the
// username-search endpoint that powers the invite typeahead.
//
// Membership model (see schema.sql app_collaborators): one table holds
// both members (status='member') and pending invites (status='invited').
// A pending invite grants NO access; declining deletes the row so
// re-invites work. The drawer's pinned Invites section is driven by
// notifications.listPendingInvites (authoritative), while the
// kind='collab_invite' notification row provides the badge bump and the
// history entry.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const notifications = require('../services/notifications');
const userDirectory = require('../services/user-directory');
const events = require('../services/events');
const { drainGuard } = require('../services/lifecycle');
const { userDirectoryLimiter } = require('../middleware/rate-limits');

// Hydrate one freshly-inserted notification row into the serialize()
// wire shape (same column set listForUser produces) and push it live.
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
  const { pushNotificationToUser } = require('../services/ws');
  for (const row of hydrated) {
    pushNotificationToUser(row.user_id, {
      type: 'notification_new',
      notification: notifications.serialize(row),
    });
  }
}

function collaboratorRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Username typeahead for the invite input. Case-insensitive prefix
  // match, capped at 10. `excludeApp=<slug>` filters out users who
  // already have any row (member or invited) on that app.
  //
  // The matching, escaping, ordering and { id, username } projection all
  // live in services/user-directory.js, which the app-facing directory
  // endpoints (#1195) read too — so a change to how the platform
  // resolves handles lands on every surface at once. The wire shape here
  // is unchanged: { users: [...] }, no has_more. Messages uses the same
  // matching helpers but adds its access-specific self/block exclusions.
  //
  // `excludeApp` IS AN ACCESS-GATED FILTER (#2521). It answers a
  // membership question — "is this handle already on that app?" — so it
  // must be resolved through appAccess.getAppForUser at the same 'collab'
  // level every other route in this file uses, not with a bare slug
  // lookup. snait's handler-level reproduction on the issue showed why:
  // with the bare lookup, a caller who is not a member of a private app
  // could diff the same search with and without `excludeApp=<private
  // slug>` and read off exactly which returned handles collaborate on
  // that app. A slug the caller cannot reach is SILENTLY IGNORED — the
  // search runs unfiltered rather than 403ing or 404ing, because either
  // refusal would itself answer "that app exists and you are not on it",
  // and because the only real caller (the Members dialog typeahead in
  // features/dialogs/members-controller.js) always passes an app it
  // already holds collab access to, so an honest request never notices.
  //
  // The limiter is the same `userDirectoryLimiter` (120/min/user) the
  // sibling app-directory search carries, for the same reason: this is a
  // per-keystroke typeahead over the whole user table, and it was the
  // one directory search surface with no bucket at all.
  router.get('/api/users/search', userDirectoryLimiter, async (req, res) => {
    const messageScope = req.query.scope === 'messages';
    const q = typeof req.query.q === 'string'
      ? req.query.q.trim().slice(0, messageScope ? 255 : 32)
      : '';
    if (!q) return res.json({ users: [] });
    try {
      let excludeAppId = null;
      if (req.query.excludeApp) {
        const app = await appAccess.getAppForUser(
          pool, String(req.query.excludeApp), req.user, 'collab', appAccess.ACCESS_COLUMNS
        );
        // No access (or no such slug) → no exclusion, no signal.
        excludeAppId = app?.id || null;
      }
      if (!messageScope) {
        const { users } = await userDirectory.searchPrefix(pool, q, 10, { excludeAppId });
        return res.json({ users });
      }

      // Messages must exclude the current user and either direction of a
      // block before applying the result limit. Keep escaping and projection
      // on the shared directory helpers so their public-user contract cannot
      // drift from the other username search surfaces.
      const escaped = userDirectory.escapeLike(q);
      const { rows } = await pool.query(
        `SELECT id, username FROM users
          WHERE LOWER(username) LIKE LOWER($1) || '%' ESCAPE '\\'
            AND ($2::int IS NULL OR id NOT IN (
              SELECT user_id FROM app_collaborators WHERE app_id = $2
            ))
            AND (NOT $3::boolean OR id <> $4)
            AND (NOT $3::boolean OR NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = $4 AND b.blocked_user_id = users.id)
                  OR (b.blocker_id = users.id AND b.blocked_user_id = $4)
            ))
          ORDER BY LOWER(username), id
          LIMIT 10`,
        [escaped, excludeAppId, messageScope, req.user.id]
      );
      res.json({ users: rows.map(userDirectory.projectUser) });
    } catch (err) {
      log.error('collab', 'user search failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Members + pending invites for the Members panel. Collab-level access.
  router.get('/api/apps/:slug/collaborators', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT ac.user_id, ac.status, ac.created_at, ac.accepted_at,
                u.username, inv.username AS invited_by
           FROM app_collaborators ac
           JOIN users u ON u.id = ac.user_id
           LEFT JOIN users inv ON inv.id = ac.invited_by
          WHERE ac.app_id = $1
          ORDER BY (ac.status = 'member') DESC, LOWER(u.username)`,
        [app.id]
      );
      res.json({
        collaborators: rows.map((r) => ({
          userId: r.user_id,
          username: r.username,
          status: r.status,
          invitedBy: r.invited_by,
          isCreator: r.user_id === app.created_by,
          createdAt: r.created_at,
          acceptedAt: r.accepted_at,
        })),
        collabVisibility: app.collab_visibility,
        viewVisibility: app.view_visibility,
        creatorId: app.created_by,
      });
    } catch (err) {
      log.error('collab', 'list failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Invite a user as a collaborator. Any collaborator (or admin) may
  // invite; only meaningful on collab-private apps.
  router.post('/api/apps/:slug/invites', drainGuard, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!username) return res.status(400).json({ error: 'username is required' });
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS + ', name'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (app.self_hosted) {
        return res.status(400).json({ error: 'The platform self-app does not use invites' });
      }
      if (app.collab_visibility !== 'private') {
        return res.status(400).json({ error: 'Everyone can already collaborate on this app' });
      }

      const { rows: userRows } = await pool.query(
        'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
        [username]
      );
      if (!userRows.length) return res.status(404).json({ error: 'User not found' });
      const target = userRows[0];
      if (target.id === req.user.id) {
        return res.status(400).json({ error: 'You are already a collaborator' });
      }

      const { rows: inserted } = await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, invited_by)
         VALUES ($1, $2, 'invited', $3)
         ON CONFLICT (app_id, user_id) DO NOTHING
         RETURNING user_id`,
        [app.id, target.id, req.user.id]
      );
      if (!inserted.length) {
        const { rows: existing } = await pool.query(
          'SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
          [app.id, target.id]
        );
        const status = existing[0]?.status;
        return res.status(409).json({
          error: status === 'member'
            ? `@${target.username} is already a collaborator`
            : `@${target.username} already has a pending invite`,
        });
      }

      // Badge bump + drawer history row, pushed live.
      try {
        const notifRows = await notifications.createCollabInviteNotification(pool, {
          appId: app.id,
          recipientId: target.id,
          inviterId: req.user.id,
        });
        await hydrateAndPush(pool, notifRows);
      } catch (err) {
        log.warn('collab', 'invite notify failed', { err: err.message });
      }

      events.record(pool, {
        type: events.EVENT_TYPES.COLLAB_INVITED,
        userId: req.user.id,
        appId: app.id,
        metadata: { invitedUserId: target.id },
      });

      log.info('collab', 'Invite sent', {
        slug: app.slug, invitee: target.username, by: req.user.username,
      });
      res.status(201).json({ ok: true, username: target.username });
    } catch (err) {
      log.error('collab', 'invite failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Accept a pending invite. Invitee-only; idempotent (accepting when
  // already a member is a no-op success, for two-tab races).
  router.post('/api/invites/:appId/accept', drainGuard, async (req, res) => {
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: 'Invalid app id' });
    try {
      const { rows: updated } = await pool.query(
        `UPDATE app_collaborators
            SET status = 'member', accepted_at = NOW()
          WHERE app_id = $1 AND user_id = $2 AND status = 'invited'
          RETURNING invited_by`,
        [appId, req.user.id]
      );

      const { rows: appRows } = await pool.query(
        'SELECT id, slug, name FROM apps WHERE id = $1', [appId]
      );
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });
      const app = appRows[0];

      if (!updated.length) {
        // No pending invite: already a member (idempotent ok) or never
        // invited (404 — don't disclose anything else).
        const isMember = await appAccess.isCollaborator(pool, appId, req.user.id);
        if (isMember) return res.json({ ok: true, appSlug: app.slug, alreadyMember: true });
        return res.status(404).json({ error: 'Invite not found' });
      }

      await notifications.markInviteNotificationsRead(pool, req.user.id, appId).catch(() => {});
      appAccess.invalidateVisibility(appId, app.slug);

      const wsSvc = require('../services/ws');
      try { wsSvc.pushNotificationToUser(req.user.id, { type: 'notifications_changed' }); } catch {}

      // Tell the inviter their invite landed.
      const inviterId = updated[0].invited_by;
      if (inviterId && inviterId !== req.user.id) {
        try {
          const notifRows = await notifications.createCollabInviteAcceptedNotification(pool, {
            appId,
            recipientId: inviterId,
            accepterId: req.user.id,
          });
          await hydrateAndPush(pool, notifRows);
        } catch (err) {
          log.warn('collab', 'accept notify failed', { err: err.message });
        }
      }

      await wsSvc.sendSystemMessage(pool, appId,
        `${req.user.username} joined as a collaborator`, 'system'
      ).catch((err) => log.warn('collab', 'join chat msg failed', { err: err.message }));

      events.record(pool, {
        type: events.EVENT_TYPES.COLLAB_JOINED,
        userId: req.user.id,
        appId,
        metadata: { invitedBy: inviterId || null },
      });

      log.info('collab', 'Invite accepted', { appId, userId: req.user.id });
      res.json({ ok: true, appSlug: app.slug });
    } catch (err) {
      log.error('collab', 'accept failed', { appId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Decline a pending invite. Deletes the row (re-invites allowed).
  // Success even when nothing was pending — races are fine.
  router.post('/api/invites/:appId/decline', drainGuard, async (req, res) => {
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: 'Invalid app id' });
    try {
      await pool.query(
        `DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2 AND status = 'invited'`,
        [appId, req.user.id]
      );
      await notifications.markInviteNotificationsRead(pool, req.user.id, appId).catch(() => {});
      try {
        const { pushNotificationToUser } = require('../services/ws');
        pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
      } catch {}
      log.info('collab', 'Invite declined', { appId, userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('collab', 'decline failed', { appId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove a member or revoke a pending invite. Allowed for admins, the
  // app creator, and the user removing themself (leave). The creator
  // cannot be removed.
  router.delete('/api/apps/:slug/collaborators/:userId', drainGuard, async (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // #788: the app's declared admins are creator-equivalent here.
      // (Self-removal stays allowed for everyone, as before.)
      const allowed = targetId === req.user?.id
        || await appAdmins.canManageApp(pool, app, req.user);
      if (!allowed) {
        return res.status(403).json({ error: 'Only the app creator or an admin can remove collaborators' });
      }
      if (targetId === app.created_by) {
        return res.status(400).json({ error: 'The app creator cannot be removed' });
      }

      const { rowCount } = await pool.query(
        'DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
        [app.id, targetId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Not a collaborator' });

      // A revoked invite's drawer entry should resolve too.
      await notifications.markInviteNotificationsRead(pool, targetId, app.id).catch(() => {});
      appAccess.invalidateVisibility(app.id, app.slug);
      try {
        const { pushNotificationToUser } = require('../services/ws');
        pushNotificationToUser(targetId, { type: 'notifications_changed' });
      } catch {}

      log.info('collab', 'Collaborator removed', {
        slug: app.slug, targetId, by: req.user.username,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('collab', 'remove failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { collaboratorRoutes };
