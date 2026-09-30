const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { queueTestAlert } = require('../services/test-alert');
const { getPool } = require('../db/pool');
const notifications = require('../services/notifications');
const messageBookmarks = require('../services/message-bookmarks');
const mobilePushPreferences = require('../services/mobile-push-preferences');
const notificationPreferences = require('../services/notification-preferences');
const log = require('../services/logger');
const appAccess = require('../services/app-access');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ── Staging mock data ──────────────────────────────────────────────────
// Request-time (?demo=1) injection of the session-related notification
// kinds — session_done, session_stalled (#3181), auto_solve_done (failed),
// stale_pr, check_failed — so the green session badge and the bell's EXCLUSION of
// these kinds from its own count are reviewable in a staging preview
// without waiting for a real session to finish, plus a
// `conversation_message` row so the message notifications the bell counts
// are reviewable without a real conversation existing in the clone. Same conventions as the other mock feeds (stagingMockProposals
// in votes.js): fixed 99xxxx ids, "[Mock]" titles, never persisted,
// strictly a no-op outside staging. Mark-read calls on these ids match
// no DB row and no-op harmlessly.
// #1374: fabricated per-app EXCEPTIONS for the Settings roll-up. The
// notification_preferences table is staging:private and therefore always
// empty in a clone, so the roll-up's whole point — "here is every app you
// have set differently" — would photograph as an empty state. Behind
// ?demo=1 + staging only, exactly like the mock feed below.
function demoNotificationOverrides() {
  return [
    {
      appId: -921, appSlug: 'staging-demo-app-a', appName: 'Staging demo app A',
      categories: [
        { key: 'new_proposals', label: 'New proposals to vote on', enabled: true },
        { key: 'new_issues', label: 'New issues', enabled: true },
      ],
    },
    {
      appId: -922, appSlug: 'staging-demo-app-b', appName: 'Staging demo app B',
      categories: [
        { key: 'proposal_status', label: 'Your proposals', enabled: false },
      ],
    },
  ];
}

function stagingMockNotifications() {
  const now = Date.now();
  const base = {
    readAt: null,
    appId: 0,
    appSlug: 'staging-demo',
    appName: 'Staging demo app',
    chatMessageId: null,
    messageContent: null,
    threadType: null,
    threadRef: null,
    sourceUsername: null,
    sessionTitle: null,
    branchName: null,
    detail: null,
  };
  return [
    // A MESSAGE notification, and the reason it has to be here: this feed is
    // what the bell's sheet renders, and a staging clone has no conversations
    // in it (`conversation_messages` is staging:private — see rule 4), so
    // without this row a preview shows the sheet with no message in it and
    // the one thing a reviewer is being asked to look at is invisible.
    //
    // Newest of the set on purpose: it leads the list, and it is what the
    // before/after screenshots of `/?shot=notifications&demo=1` are shot on.
    //
    // The app fields are NULLED rather than inherited from `base`: serialize()
    // fails a conversation row closed when it also carries legacy app fields,
    // so a mock that kept `appId: 0` would be describing a shape the real
    // pipeline refuses to emit. Same conventions as the rows below otherwise —
    // a fixed 99xxxx id, "[Mock]" copy, request-time only, never persisted, a
    // strict no-op outside staging. Opening it routes to a conversation id
    // that matches no row and lands on the ordinary "no longer available"
    // state, exactly as the mock invite hits a nonexistent app.
    {
      ...base,
      id: 990207, kind: 'conversation_message',
      createdAt: new Date(now - 2 * 60 * 1000).toISOString(),
      appId: null, appSlug: null, appName: null,
      sourceUsername: 'staging-demo-user',
      conversationId: 990401,
      conversationKind: 'direct',
      conversationTitle: '[Mock] Staging demo conversation',
      conversationMessageId: 990501,
      messageContent: '[Mock] Did the notifications change land yet?',
      sessionId: null, sessionTitle: null,
      prTitle: null, prNumber: null, headlessIssueNumber: null,
    },
    // ...and its predecessor in the SAME conversation, one minute older and
    // adjacent to it in this list. That adjacency is the point: a run of
    // consecutive same-conversation rows collapses to one row carrying a
    // count (collapseConversationRuns in the notifications module), which is
    // the behaviour a preview has to be able to show. One demo message would
    // render an ordinary uncollapsed row and prove nothing.
    {
      ...base,
      id: 990208, kind: 'conversation_message',
      createdAt: new Date(now - 3 * 60 * 1000).toISOString(),
      appId: null, appSlug: null, appName: null,
      sourceUsername: 'staging-demo-user',
      conversationId: 990401,
      conversationKind: 'direct',
      conversationTitle: '[Mock] Staging demo conversation',
      conversationMessageId: 990502,
      messageContent: '[Mock] Ping - are you around?',
      sessionId: null, sessionTitle: null,
      prTitle: null, prNumber: null, headlessIssueNumber: null,
    },
    // #971: the issue's exact case — a session that finished BEFORE it was
    // promoted, so it has a session title but no PR title. The row must show
    // the title, never the `dev/…` branch name beside it.
    {
      ...base,
      id: 990201, kind: 'session_done',
      createdAt: new Date(now - 4 * 60 * 1000).toISOString(),
      sessionId: 990101,
      sessionTitle: '[Mock] Session titled but not yet proposed',
      prTitle: null, branchName: 'dev/mockuser-1700000000000',
      prNumber: null, headlessIssueNumber: null,
    },
    // #3181: a session whose turn stopped before finishing. A real one needs
    // a turn to error, time out or lose its worker, which a preview cannot
    // arrange on demand, so this row is how the new bell row is reviewable.
    {
      ...base,
      id: 990211, kind: 'session_stalled',
      createdAt: new Date(now - 6 * 60 * 1000).toISOString(),
      sessionId: 990110,
      sessionTitle: '[Mock] Session that stopped before finishing',
      prTitle: null, branchName: 'dev/mockuser-1700000000004',
      prNumber: null, headlessIssueNumber: null,
    },
    // A platform limit alert (services/platform-limit-alerts.js). A preview
    // never sends a real one — its users are a production clone, so the
    // service records the level there and notifies nobody — which leaves this
    // row the only way a reviewer or a declared check sees the kind render.
    // No app, like the real row: the cap belongs to the server. Its copy is
    // built from the detail token, so the figures stand in for "[Mock]".
    // Placed after 990201 (and timed between it and 990202) so the message
    // pair above still leads and stays consecutive.
    {
      ...base,
      id: 990210, kind: 'platform_limit',
      createdAt: new Date(now - 8 * 60 * 1000).toISOString(),
      appId: null, appSlug: null, appName: null,
      detail: 'apps_warn:40:50',
      sessionId: null, prTitle: null, prNumber: null, headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990202, kind: 'auto_solve_done', detail: 'failed',
      createdAt: new Date(now - 12 * 60 * 1000).toISOString(),
      sessionId: null, prTitle: null, prNumber: null,
      headlessIssueNumber: 900002,
    },
    {
      ...base,
      id: 990203, kind: 'stale_pr',
      createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
      sessionId: 990103,
      sessionTitle: '[Mock] Stale proposal going quiet',
      prTitle: '[Mock] Stale proposal going quiet',
      prNumber: 9901, headlessIssueNumber: null,
    },
    {
      ...base,
      id: 990204, kind: 'check_failed',
      createdAt: new Date(now - 55 * 60 * 1000).toISOString(),
      sessionId: 990104,
      sessionTitle: "[Mock] Proposal whose preview won't boot",
      prTitle: "[Mock] Proposal whose preview won't boot",
      prNumber: 9902, headlessIssueNumber: null,
    },
    // #971: the untitled tail of the ladder — a session that finished before
    // its title was generated still falls back to the branch name, so the row
    // can never render blank.
    {
      ...base,
      id: 990205, kind: 'session_done',
      createdAt: new Date(now - 70 * 60 * 1000).toISOString(),
      sessionId: 990105,
      sessionTitle: null, prTitle: null,
      branchName: 'dev/mockuser-1700000000001',
      prNumber: null, headlessIssueNumber: null,
    },
    // An ALREADY-READ row. The drawer lists unread notifications and parks the
    // read ones behind "See N older notifications", so without one of these a
    // staging preview has nothing behind that button — it does not render at
    // all, the "you're all caught up" state can never be reached, and the two
    // things a reviewer is being asked to look at are both invisible.
    //
    // `readAt` in the past is the whole point of the row, and it is the only
    // thing that distinguishes it from the four above. Same conventions as
    // they use: a fixed 99xxxx id, a "[Mock]" title, request-time only, never
    // persisted, and a no-op outside staging — marking it read again matches
    // no DB row and harmlessly does nothing.
    {
      ...base,
      id: 990206, kind: 'session_done',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      readAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      sessionId: 990106,
      sessionTitle: '[Mock] Something you already read',
      prTitle: null, branchName: 'dev/mockuser-1700000000002',
      prNumber: null, headlessIssueNumber: null,
    },
    // #1808: the row that is PAST the relative form's seven-day floor, and
    // fixed in an earlier year so it stays past it. Every other row here is
    // minutes or days old, so without this one a preview shows only the "12m
    // ago" half of the change and never the date the old code could not
    // reach: these rows had no floor at all and printed "412d ago".
    //
    // UNREAD on purpose, which is both where the bug was worst and the only
    // way a preview can see it: the sheet opens on the Unread tab, so a read
    // row of this age is one click away from every screenshot and declared
    // check. An old unread notification is exactly the row that used to read
    // as a four-hundred-day duration.
    {
      ...base,
      id: 990209, kind: 'session_done',
      createdAt: '2024-05-21T14:05:00Z',
      readAt: null,
      sessionId: 990108,
      sessionTitle: '[Mock] Something from an earlier year',
      prTitle: null, branchName: 'dev/mockuser-1700000000003',
      prNumber: null, headlessIssueNumber: null,
    },
  ];
}

// #1280: staging demo rows for the drawer's pinned "Saved" section.
// `message_bookmarks` is `staging:private` (it is one person's private
// feed), so a staging clone has the table and none of the rows and the
// section would render empty in every preview — the same problem
// stagingMockNotifications above solves for the session kinds, solved the
// same way: request-time (?demo=1) injection, never persisted, a strict
// no-op outside staging. Unsaving one of these hits a message id that
// matches no row and no-ops harmlessly, exactly like a mark-read on a mock
// notification.
function stagingMockSavedMessages() {
  const now = Date.now();
  return [
    {
      messageId: 990301,
      appId: 0,
      appSlug: 'staging-demo',
      appName: 'Staging demo app',
      author: 'staging-demo-user',
      content: '[Mock] The deploy runbook lives in docs/deploy.md — '
        + 'saving this so I can find it again on Friday.',
      threadType: null,
      threadRef: null,
      savedAt: new Date(now - 8 * 60 * 1000).toISOString(),
      messageCreatedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    },
    {
      messageId: 990302,
      appId: 0,
      appSlug: 'staging-demo',
      appName: 'Staging demo app',
      author: 'staging-demo-reviewer',
      content: '[Mock] Decision from the thread: we ship the smaller '
        + 'version first and revisit the picker next week.',
      threadType: 'issue',
      threadRef: 990001,
      savedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
      messageCreatedAt: new Date(now - 27 * 60 * 60 * 1000).toISOString(),
    },
  ];
}

// Routes for the top-right notifications dropdown. All routes assume
// authMiddleware has already attached `req.user`.
function notificationsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const testAlertLimiter = rateLimit({
    windowMs: 60000,
    limit: 3,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Please wait a minute before sending another test alert.' },
  });
  router.post('/api/me/test-alert', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }, testAlertLimiter, async (req, res) => {
    try {
      return res.json(await queueTestAlert(pool, req.user.id));
    } catch (err) {
      log.error('test-alert', 'queue failed', { message: err.message });
      return res.status(500).json({ error: 'Could not queue the test push. Please try again.' });
    }
  });

  // Account-level mobile-push policy. This is intentionally a browser-
  // session surface rather than a phone-registration surface: any signed-in
  // Social browser may configure the account, while each phone keeps its
  // independent Activity notifications master switch.
  router.get('/api/me/mobile-push-preferences', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const preferences = await mobilePushPreferences.readPreferences(pool, req.user.id);
      return res.json({ preferences });
    } catch (err) {
      log.error('mobile-push-preferences', 'read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/me/mobile-push-preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { details, values } = mobilePushPreferences.validatePreferencePatch(req.body);
    if (Object.keys(details).length) {
      return res.status(422).json({
        error: 'The given data was invalid.',
        details,
      });
    }
    try {
      const preferences = await mobilePushPreferences.writePreferences(
        pool, req.user.id, values
      );
      return res.json({ preferences });
    } catch (err) {
      log.error('mobile-push-preferences', 'update failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Per-app notification preferences (#1374) ────────────────────────
  //
  // The sibling of the two routes above, and a different question: those
  // decide whether a notification that EXISTS may reach a phone, these
  // decide whether it is created at all for a given app. See
  // services/notification-preferences.js for why that distinction is what
  // keeps the phone push and the on-platform row in sync.

  // Resolve a slug to an app id and say whether this user administers it.
  // `adminOnly` categories are hidden from everyone else, because the
  // notifications behind them are only ever addressed to admins and the
  // creator in the first place.
  //
  // Answers only for an app the user may VIEW (appAccess.checkAppAccess,
  // as every other /api/apps/:slug route): a private, suspended or blocked
  // app is null, exactly like a missing one, so these routes never disclose
  // it. `allowOwnRows` is the reset's exception: someone who has since lost
  // access may still clear preference rows they already hold for the app,
  // which is what the Settings roll-up offers them. Without such rows the
  // answer is the same null as for a slug that does not exist.
  async function resolveApp(slug, user, { allowOwnRows = false } = {}) {
    const { rows } = await pool.query(
      `SELECT ${appAccess.ACCESS_COLUMNS}, name,
              EXISTS (SELECT 1 FROM app_admins ad
                       WHERE ad.app_id = apps.id AND ad.user_id = $2) AS is_admin
         FROM apps WHERE slug = $1`,
      [slug, user.id]
    );
    const app = rows[0];
    if (!app) return null;
    if (!(await appAccess.checkAppAccess(pool, app, user, 'view'))) {
      if (!allowOwnRows) return null;
      const own = await pool.query(
        'SELECT 1 FROM notification_preferences WHERE user_id = $1 AND app_id = $2 LIMIT 1',
        [user.id, app.id]
      );
      if (!own.rows.length) return null;
    }
    return { ...app, isAdmin: !!app.is_admin || app.created_by === user.id };
  }

  router.get('/api/apps/:slug/notification-preferences', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const app = await resolveApp(req.params.slug, req.user);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const overrides = await notificationPreferences.readOverrides(pool, req.user.id, app.id);
      return res.json({
        app: { id: app.id, slug: app.slug, name: app.name },
        categories: notificationPreferences.serializeAppCategories({
          ...overrides,
          isAdmin: app.isAdmin,
        }),
      });
    } catch (err) {
      log.error('notification-preferences', 'app read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/apps/:slug/notification-preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const app = await resolveApp(req.params.slug, req.user);
      if (!app) return res.status(404).json({ error: 'App not found' });

      // The allowed set is computed from THIS user's admin status, so a
      // non-admin posting `app_health` is refused rather than quietly
      // storing a preference for something they will never be sent.
      const allowedKeys = notificationPreferences.APP_CATEGORY_DEFINITIONS
        .filter((category) => !category.adminOnly || app.isAdmin)
        .map((category) => category.key);
      const { details, values } = notificationPreferences.validatePreferencePatch(
        req.body, { allowedKeys }
      );
      if (Object.keys(details).length) {
        return res.status(422).json({ error: 'The given data was invalid.', details });
      }

      const overrides = await notificationPreferences.writeOverrides(
        pool, req.user.id, app.id, values
      );
      return res.json({
        app: { id: app.id, slug: app.slug, name: app.name },
        categories: notificationPreferences.serializeAppCategories({
          ...overrides,
          isAdmin: app.isAdmin,
        }),
      });
    } catch (err) {
      log.error('notification-preferences', 'app write failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The account-wide layer plus every per-app exception, for the Settings
  // roll-up. The exceptions are what make the roll-up worth having: without
  // them there is no way to find an app you muted months ago short of
  // opening its tile menu and looking.
  router.get('/api/me/notification-preferences', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    if (req.query.demo === '1' && IS_STAGING) {
      return res.json({
        categories: notificationPreferences.serializeAccountCategories({}),
        apps: demoNotificationOverrides(),
        demo: true,
      });
    }

    try {
      const { accountOverrides } = await notificationPreferences.readOverrides(
        pool, req.user.id, null
      );
      const { rows } = await pool.query(
        `SELECT p.app_id, p.category, p.enabled, a.slug, a.name
           FROM notification_preferences p
           JOIN apps a ON a.id = p.app_id
          WHERE p.user_id = $1 AND p.app_id IS NOT NULL
          ORDER BY a.name ASC, p.category ASC`,
        [req.user.id]
      );
      const byApp = new Map();
      for (const row of rows) {
        const definition = notificationPreferences.definitionFor(row.category);
        if (!definition) continue;
        if (!byApp.has(row.app_id)) {
          byApp.set(row.app_id, {
            appId: row.app_id, appSlug: row.slug, appName: row.name, categories: [],
          });
        }
        byApp.get(row.app_id).categories.push({
          key: row.category, label: definition.label, enabled: row.enabled,
        });
      }
      return res.json({
        categories: notificationPreferences.serializeAccountCategories({ accountOverrides }),
        apps: [...byApp.values()],
      });
    } catch (err) {
      log.error('notification-preferences', 'account read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/me/notification-preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { details, values } = notificationPreferences.validatePreferencePatch(req.body);
    if (Object.keys(details).length) {
      return res.status(422).json({ error: 'The given data was invalid.', details });
    }
    try {
      const { accountOverrides } = await notificationPreferences.writeOverrides(
        pool, req.user.id, null, values
      );
      return res.json({
        categories: notificationPreferences.serializeAccountCategories({ accountOverrides }),
      });
    } catch (err) {
      log.error('notification-preferences', 'account write failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Clear every per-app exception for one app: the roll-up's "follow my
  // defaults again" button. A DELETE of the overrides rather than writing
  // them all to the default value, so the app goes back to INHERITING and
  // keeps doing so if a default ever changes.
  router.delete('/api/apps/:slug/notification-preferences', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const app = await resolveApp(req.params.slug, req.user, { allowOwnRows: true });
      if (!app) return res.status(404).json({ error: 'App not found' });
      await pool.query(
        'DELETE FROM notification_preferences WHERE user_id = $1 AND app_id = $2',
        [req.user.id, app.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      log.error('notification-preferences', 'app reset failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Full dropdown payload: recent notifications (read and unread) + an
  // unread count so the badge and list stay in sync on initial page load.
  //
  // Pagination (#84 scroll-to-load-more): the client passes
  // `?before=<createdAt>&before_id=<id>&limit=<n>` to fetch the page
  // strictly older than that keyset cursor. We over-fetch nothing — a
  // returned page exactly `limit` long means there may be more, so we
  // hand back `nextBefore` (the cursor for the next page) and `hasMore`.
  // The unread count is omitted on paginated follow-up requests (it's a
  // whole-account aggregate the client already has from the first page).
  router.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 100;

      let before = null;
      if (req.query.before) {
        const beforeId = Number(req.query.before_id);
        before = {
          createdAt: req.query.before,
          id: Number.isFinite(beforeId) ? beforeId : 0,
        };
      }

      // `?kind=conversation` narrows the page to the conversation kinds — the
      // bell's Messages tab. That tab filters the shared feed client-side, so
      // its pager used to walk the WHOLE feed 100 rows at a time looking for
      // messages, which is why it did not page in place at all. A named group
      // rather than a free list of kinds: the client does not get to select
      // arbitrary rows out of its own feed, and the grouping stays defined in
      // one place (services/notifications.js).
      const kinds = req.query.kind === 'conversation'
        ? [...notifications.CONVERSATION_NOTIFICATION_KINDS]
        : null;

      const rows = await notifications.listForUser(pool, req.user.id, { limit, before, kinds });
      const serialized = rows.map(notifications.serialize);

      const hasMore = rows.length === limit;
      const last = rows[rows.length - 1];
      const nextBefore = hasMore && last
        ? { createdAt: last.created_at, id: last.id }
        : null;

      // Only compute the account-wide unread aggregate on the first page;
      // follow-up (cursor) fetches just append older rows.
      const payload = {
        notifications: serialized,
        hasMore,
        nextBefore,
      };
      if (!before) {
        payload.unread = await notifications.countUnread(pool, req.user.id);
        // #3050: the bell just learned the true total, so re-badge the
        // iPhone to it. The icon changes only when a push carries
        // `aps.badge` — the native shell does not implement the WebView's
        // setSocialBadgeCount seam — so a clear that never announced
        // itself (a kudos retraction, a conversation left or archived, a
        // cascade) otherwise left the icon on a number the bell no longer
        // shows, with nothing in the app able to correct it. Debounced per
        // user and a no-op without a live iOS registration.
        try { require('../services/mobile-push').scheduleBadgeSync(req.user.id); } catch {}
        // Pending collaborator invites for the drawer's pinned Invites
        // section. Sourced from app_collaborators (authoritative about
        // what's still actionable), not from collab_invite notification
        // rows. First page only — like `unread`, it's an account-wide
        // aggregate the client already has on cursor follow-ups.
        payload.pendingInvites = await notifications.listPendingInvites(pool, req.user.id);
        // #1280: this user's saved messages, for the drawer's pinned
        // "Saved" section. First page only for the same reason as the two
        // aggregates above — the section is pinned, not paginated, so a
        // cursor follow-up would only re-send what the client already has.
        // Best-effort: a failure here renders an empty section rather than
        // 500ing the whole dropdown.
        //
        // Both kinds of save land in this one list: an app's group chat and
        // the Messages area's conversations. They are separate tables (see
        // src/services/message-bookmarks.js) but one SECTION, so they are
        // merged here and sorted by save time — the section is "what I
        // saved, most recent first", and splitting it by where the message
        // happened to be posted would make the reader do the merge instead.
        // The cap is applied after the merge for the same reason.
        const [appSaved, conversationSaved] = await Promise.all([
          messageBookmarks.listForUserSafe(
            pool, req.user.id, { isAdmin: !!req.user.isAdmin }
          ),
          messageBookmarks.listConversationsForUserSafe(pool, req.user.id),
        ]);
        payload.savedMessages = [...appSaved, ...conversationSaved]
          .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
          .slice(0, messageBookmarks.MAX_SAVED);
        // Staging-only demo rows (?demo=1) — see stagingMockNotifications.
        // First page only (they'd duplicate on cursor follow-ups), unread
        // count bumped to match so the bell's number counts the mocks it is
        // showing. (It used to be phrased as keeping a subtraction honest:
        // the client held back the session kinds for a second badge on
        // #improve-btn. #1610 folded that count into the bell, so the total
        // is simply the total now.)
        //
        // Only the UNREAD mocks are counted. This used to add `mocks.length`
        // outright, which was right while every mock was unread; one of them
        // now ships with a `readAt` (so the drawer's "older notifications"
        // view has something behind it), and counting that one would claim an
        // already-read row as unread — inflating the red badge by one and
        // leaving "Mark all read" enabled with nothing left to mark.
        if (IS_STAGING && req.query.demo === '1') {
          const mocks = stagingMockNotifications();
          payload.notifications = [...mocks, ...payload.notifications];
          payload.unread += mocks.filter((m) => !m.readAt).length;
          // Pinned-invite demo row: drives the drawer's Invites section
          // and its swipe Accept/Decline path in a staging preview.
          // Obviously fake (staging-demo-*); acting on it hits a
          // nonexistent app and surfaces a normal error toast.
          payload.pendingInvites = [
            {
              appId: 990001,
              appSlug: 'staging-demo',
              appName: 'Staging demo app',
              invitedBy: 'staging-demo-user',
              kind: 'collab',
              createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            },
            ...(payload.pendingInvites || []),
          ];
          // Pinned saved-message demo rows (#1280) — see
          // stagingMockSavedMessages. Prepended, so a staging clone that
          // somehow does carry real saves still shows them below.
          payload.savedMessages = [
            ...stagingMockSavedMessages(),
            ...(payload.savedMessages || []),
          ];
        }
      }
      res.json(payload);
    } catch (err) {
      log.error('notifications', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Native push carries no notification copy or route, only an opaque id.
  // Resolve that id through the authenticated Social session and deliberately
  // return the same 404 for an absent row and another user's row.
  router.get('/api/notifications/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    const rawId = String(req.params.id || '');
    if (!/^[1-9]\d{0,9}$/.test(rawId)) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id > 2147483647) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    try {
      const row = await notifications.getForUser(pool, req.user.id, id);
      if (!row) {
        return res.status(404).json({ error: 'Notification not found' });
      }
      return res.json({ notification: notifications.serialize(row) });
    } catch (err) {
      log.error('notifications', 'exact lookup failed', {
        id,
        message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    res.set('Cache-Control', 'private, no-store');
    const {
      id, all, chat_message_id: chatMessageId, app_id: appId,
      conversation_id: conversationId, session_id: sessionId,
      kinds, exclude_kinds: excludeKinds,
    } = req.body || {};
    // Kind scoping for the split drawers (cog vs bell). Sanitize to
    // string arrays; anything else is treated as absent.
    const kindList = Array.isArray(kinds) ? kinds.filter((k) => typeof k === 'string') : null;
    const excludeList = Array.isArray(excludeKinds) ? excludeKinds.filter((k) => typeof k === 'string') : null;
    try {
      // Platform conversations are a separate notification domain from app
      // chats. A dedicated scope prevents equal integer ids from clearing
      // one another and gives conversation groups one atomic mark-read path.
      if (conversationId != null) {
        const rawConversationId = String(conversationId);
        if (!/^[1-9]\d{0,9}$/.test(rawConversationId)) {
          return res.status(400).json({ error: 'Invalid conversation id' });
        }
        const parsedConversationId = Number(rawConversationId);
        if (!Number.isSafeInteger(parsedConversationId) || parsedConversationId > 2147483647) {
          return res.status(400).json({ error: 'Invalid conversation id' });
        }
        const cleared = await notifications.markReadForConversation(
          pool, req.user.id, parsedConversationId
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ session_id }` (#2847): the viewer opened or touched a proposal card
      // on the dev board, which resolves that proposal's "New proposal" nudge
      // (the registry's `proposal_opened`: pr_proposed only). Same validation
      // and fan-out shape as the conversation branch above.
      if (sessionId != null) {
        const rawSessionId = String(sessionId);
        const parsedSessionId = Number(rawSessionId);
        if (!/^[1-9]\d{0,9}$/.test(rawSessionId) || parsedSessionId > 2147483647) {
          return res.status(400).json({ error: 'Invalid session id' });
        }
        const cleared = await notifications.markReadForAction(
          pool, req.user.id, 'proposal_opened', parsedSessionId
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ app_id }` is the per-group "Mark read" path (#84 grouping):
      // clear every unread notification this user has for one app, in a
      // single round-trip. Mirrors the chat_message_id branch below —
      // returns the fresh unread count and fans out a cross-tab refresh
      // when something actually changed.
      if (appId != null) {
        const cleared = await notifications.markReadForApp(
          pool, req.user.id, Number(appId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ chat_message_id }` is the in-chat "click a dotted message" path:
      // clear the user's unread mention/reply/reaction notification(s) for
      // that one message. Falls through to the existing single-id / all
      // behavior otherwise.
      if (chatMessageId != null) {
        const cleared = await notifications.markReadForMessage(
          pool, req.user.id, Number(chatMessageId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        // Sync this user's other tabs (bell badge + the same message's dot
        // in another open chat tab) only when something actually changed.
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // Single-id / mark-all path. Mark-all (#449) previously skipped the
      // `notifications_changed` fan-out every other clearing branch does,
      // so the clicking tab's in-chat unread dots and the user's other
      // open tabs/devices kept showing unread state until a full reload —
      // making "Mark all read" look like it did nothing. Fan out exactly
      // like the branches above whenever something actually changed.
      const cleared = await notifications.markRead(pool, req.user.id, {
        id, all: !!all, kinds: kindList, excludeKinds: excludeList,
      });
      const unread = await notifications.countUnread(pool, req.user.id);
      if (cleared > 0) {
        try {
          const { pushNotificationToUser } = require('../services/ws');
          pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        } catch (err) {
          log.warn('notifications', 'cross-tab push failed', { message: err.message });
        }
      }
      res.json({ unread, cleared });
    } catch (err) {
      log.error('notifications', 'markRead failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  notificationsRoutes, stagingMockNotifications, stagingMockSavedMessages,
};
