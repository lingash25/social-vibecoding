'use strict';

// Mutual friends (#2386) — the viewer's side of it, and nothing else.
//
//   GET    /api/friends                   → { friends, incoming, outgoing }
//   GET    /api/friends/:userId           → { userId, state }
//   POST   /api/friends/:userId/request   → { userId, state }   send (or accept theirs)
//   DELETE /api/friends/:userId/request   → { userId, state }   cancel yours
//   POST   /api/friends/:userId/accept    → { userId, state }
//   POST   /api/friends/:userId/decline   → { userId, state }   silent
//   DELETE /api/friends/:userId           → { userId, state }   unfriend, silent
//
// `state` is always the relationship as the VIEWER now sees it: none,
// outgoing, incoming or friends. A write that finds nothing to do (an accept
// the requester withdrew a moment ago, a second cancel) answers 200 with the
// current state rather than an error, so a button that was one step behind
// simply catches up.
//
// PRIVATE by construction: every route reads or writes the signed-in viewer's
// own rows. There is no route that lists or counts anybody else's friends,
// and the per-person read answers only the viewer's own relationship. A
// refused request — blocked either way, a missing account, yourself — is one
// generic 404, as a direct message is (routes/conversations.js).
//
// ?demo=1 on a staging preview answers from services/friends.js's fixtures
// and writes nothing, the way the Messages demo does.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const friends = require('../services/friends');
const { strictId } = require('../services/conversations');
const { friendshipLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const NOT_FOUND = { error: 'User not found' };

function privateJson(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

function pushNotificationsChanged(userIds) {
  if (!userIds?.length) return;
  const { pushToUser } = require('../services/ws');
  for (const userId of [...new Set(userIds)]) pushToUser(userId, { type: 'notifications_changed' });
}

function pushConversationChanges(conversationIds, memberIds) {
  if (!conversationIds?.length) return;
  const ws = require('../services/ws');
  for (const conversationId of conversationIds) {
    const payload = { type: 'conversation_membership_changed', conversationId };
    if (typeof ws.pushConversationEvent === 'function') ws.pushConversationEvent(memberIds, payload);
    else for (const userId of memberIds) ws.pushToUser(userId, payload);
  }
}

function friendRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  router.use('/api/friends', privateJson);

  router.get('/api/friends', async (req, res) => {
    try {
      if (isDemo(req)) return res.json({ ...friends.demoLists(), demo: true });
      return res.json(await friends.listFor(pool, req.user.id));
    } catch (err) {
      log.error('friends', 'list failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/friends/:userId', async (req, res) => {
    const userId = strictId(req.params.userId);
    if (!userId || userId === req.user.id) return res.status(404).json(NOT_FOUND);
    try {
      if (isDemo(req)) {
        const person = friends.DEMO_PEOPLE.find((p) => p.id === userId);
        if (person) return res.json({ userId, state: person.state, demo: true });
      }
      const relationship = await friends.relationshipFor(pool, req.user.id, userId);
      return res.json(relationship || { userId, state: 'none' });
    } catch (err) {
      log.error('friends', 'state read failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // One handler shape for all five writes: resolve the id, run the service
  // call, then fan out what changed — the new notification to its recipient,
  // a bell refresh to anyone whose row was answered or withdrawn, and a
  // membership refresh for a direct message friendship just opened.
  function write(action, run) {
    return async (req, res) => {
      const userId = strictId(req.params.userId);
      if (!userId || userId === req.user.id) return res.status(404).json(NOT_FOUND);
      try {
        if (isDemo(req)) {
          const demo = friends.demoTransition(action, userId);
          if (demo) return res.json({ ...demo, demo: true });
        }
        const result = await run(pool, req.user, userId);
        if (result.notifications.length) {
          const notificationSvc = require('../services/notifications');
          for (const row of result.notifications) await notificationSvc.hydrateAndPush(pool, row);
        }
        pushNotificationsChanged(result.changedNotificationUserIds);
        pushConversationChanges(result.conversationIds, [req.user.id, userId]);
        return res.json({ userId, state: result.state });
      } catch (err) {
        if (err instanceof friends.FriendsError) {
          return res.status(err.status).json(err.status === 404
            ? NOT_FOUND
            : { error: err.message, code: err.code });
        }
        log.error('friends', `${action} failed`, { userId: req.user.id, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    };
  }

  // Every write refuses a browser request the Homeroom page did not send
  // (middleware/same-site-browser.js).
  router.post('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('request', friends.sendRequest));
  router.delete('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('cancel', friends.cancel));
  router.post('/api/friends/:userId/accept', friendshipLimiter, sameOriginBrowserOnly, write('accept', friends.accept));
  router.post('/api/friends/:userId/decline', friendshipLimiter, sameOriginBrowserOnly, write('decline', friends.decline));
  router.delete('/api/friends/:userId', friendshipLimiter, sameOriginBrowserOnly, write('unfriend', friends.unfriend));

  return router;
}

module.exports = { friendRoutes };
