'use strict';

const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const conversations = require('../services/conversations');
const communities = require('../services/communities');
const contactPrivacy = require('../services/contact-privacy');
const messageBookmarks = require('../services/message-bookmarks');
const attachments = require('../services/attachments');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const {
  attachmentUploadLimiter,
  conversationMessageLimiter,
  conversationActionLimiter,
  conversationSafetyLimiter,
  conversationInviteLimiter,
  conversationReactionLimiter,
  conversationReportLimiter,
  linkCardLimiter,
  userDirectoryLimiter,
} = require('../middleware/rate-limits');
const sharedObjects = require('../services/shared-objects');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const MAX_CONVERSATION_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const MAX_USER_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MAX_CONVERSATION_TEXT_BYTES = 200 * 1024;
const NOT_FOUND = { error: 'Conversation not found' };

function privateJson(_req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function sendNotFound(res) {
  return res.status(404).json(NOT_FOUND);
}

// #2387's two refusals that are not "not found": a thread in a direct
// conversation other than the chat with the Homeroom bot (400,
// services/conversations.js threadsAllowed) and a change to a deleted
// message (409).
const THREADS_NOT_SUPPORTED = Object.freeze({ error: 'threads_not_supported' });
const MESSAGE_DELETED = Object.freeze({ error: 'message_deleted' });
// QA 2026-09-24 Q2: a second message into a direct request the other person
// has not accepted yet. The conversation exists and the sender is in it; the
// send is refused until they accept, so it is a conflict, not a 404.
const AWAITING_ACCEPTANCE = Object.freeze({ error: 'awaiting_acceptance' });

// #5104: a new direct message or invitation to someone who takes them only
// from people in projects with them (users.contact_policy). 403 with a code
// the Messages screen words itself; the body says nothing about the person.
function sendContactRestricted(res) {
  return res.status(403).json(contactPrivacy.CONTACT_RESTRICTED);
}

function sendMessageError(res, error) {
  if (error === 'threads_not_supported') return res.status(400).json(THREADS_NOT_SUPPORTED);
  if (error === 'message_deleted') return res.status(409).json(MESSAGE_DELETED);
  if (error === 'awaiting_acceptance') return res.status(409).json(AWAITING_ACCEPTANCE);
  return sendNotFound(res);
}

function pushAudience(memberIds, payload, options) {
  const ws = require('../services/ws');
  if (typeof ws.pushConversationEvent === 'function') {
    return ws.pushConversationEvent(memberIds, payload, options);
  }
  let sent = 0;
  for (const userId of [...new Set(memberIds || [])]) {
    if (options?.excludeUserId === userId) continue;
    sent += ws.pushToUser(userId, payload, options);
  }
  return sent;
}

// #3050: a membership change or a retracted reaction can drop someone's
// unread total without touching the notification feed's own read paths.
// Announcing it as `notifications_changed` refreshes their bell and, through
// ws.pushToUser, re-badges their iPhone to the same count.
function pushNotificationsChanged(userIds) {
  const ws = require('../services/ws');
  for (const userId of new Set(userIds || [])) {
    ws.pushToUser(userId, { type: 'notifications_changed' });
  }
}

async function pushNotifications(pool, rows) {
  if (!rows?.length) return;
  const notificationSvc = require('../services/notifications');
  for (const row of rows) await notificationSvc.hydrateAndPush(pool, row);
}

const stagingMessages = require('../services/staging-messages');

function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

function conversationRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  router.use('/api/conversations', privateJson);
  router.use('/api/me/blocks', privateJson);

  router.get('/api/conversations', async (req, res) => {
    try {
      if (isDemo(req)) {
        await stagingMessages.ensureFixtures(pool, req.user);
        // #3624: and the Homeroom bot's DM, with a question open.
        await stagingMessages.ensureBotDmFixture(pool, req.user).catch((err) => {
          log.warn('conversations', 'Staging bot DM fixture failed', { err: err.message });
        });
      }
      return res.json({ conversations: await conversations.listConversations(pool, req.user) });
    } catch (err) {
      log.error('conversations', 'list failed', { err: err.message, userId: req.user.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3692: the activity tray at the top of the Homeroom bot's DM: what the
  // bot is working on for the signed-in person now, and what it did for them
  // before (services/homeroom-bot-tray.js). Their own work only: it takes no
  // user parameter, and reads every row by req.user's id. Not a conversation
  // id: the segment is a word, and no route takes `/:id/work`.
  router.get('/api/conversations/homeroom-bot/work', async (req, res) => {
    try {
      const tray = require('../services/homeroom-bot-tray');
      if (isDemo(req)) return res.json(await tray.demoWorkFor(pool, req.user));
      return res.json(await tray.workFor(pool, { user: req.user }));
    } catch (err) {
      log.error('conversations', 'homeroom bot work failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3736: how far along each activity card in the signed-in person's DM
  // with the Homeroom bot is (services/homeroom-bot-activity.js): one piece
  // of the bot's work per card, read from its records. Their own cards only:
  // it takes no user, conversation or message parameter.
  router.get('/api/conversations/homeroom-bot/activity', async (req, res) => {
    try {
      const activity = require('../services/homeroom-bot-activity');
      if (isDemo(req)) return res.json(await activity.demoCards(pool, req.user));
      return res.json(await activity.cardsFor(pool, { user: req.user, config }));
    } catch (err) {
      log.error('conversations', 'homeroom bot activity failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The client opened its DM with the Homeroom bot: any of the signed-in
  // person's work the bot has under way without an activity card gets one
  // (services/homeroom-bot-activity.js catchUpCards). A write, so not the
  // read above: idempotent, it sends each missing card once and nothing on a
  // second call. Their own work only: it reads nothing from the request but
  // who is signed in. → { added }
  router.post('/api/conversations/homeroom-bot/activity', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      if (isDemo(req)) return res.json(await stagingMessages.ensureDemoUnderWayCard(pool, req.user));
      const activity = require('../services/homeroom-bot-activity');
      return res.json(await activity.catchUpCards(pool, { user: req.user }));
    } catch (err) {
      log.error('conversations', 'homeroom bot activity catch-up failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // B8: the signed-in person's chat with Homeroom bot, made the first time:
  // where every "ask Homeroom bot" door leads (Messages' +, a request's page,
  // a change's page). Their own DM only; it takes no user.
  //
  //   POST /api/conversations/homeroom-bot  → { conversationId }
  router.post('/api/conversations/homeroom-bot', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      // 1 Nov 2026: the staging demo's chat, with its fixture in it before the
      // Homeroom bot tab, which opens the chat here, reads it (as the list does above).
      if (isDemo(req)) {
        const demo = await stagingMessages.ensureBotDmFixture(pool, req.user).catch((err) => {
          log.warn('conversations', 'Staging bot DM fixture failed', { err: err.message });
          return null;
        });
        if (demo) return res.json({ conversationId: Number(demo) });
      }
      const bot = await require('../services/homeroom-bot-dm').botAccount(pool);
      if (!bot) return res.status(404).json({ error: 'Homeroom bot is not available' });
      const opened = await conversations.ensureAdmittedDirect(pool, bot.id, req.user.id);
      if (!opened?.conversationId) return res.status(409).json({ error: 'Could not open the chat' });
      return res.json({ conversationId: opened.conversationId });
    } catch (err) {
      log.error('conversations', 'opening the Homeroom bot chat failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // B3: a tap on one of a Homeroom bot message's buttons (its metadata's
  // `actions`), decided on the server as the person it was offered to, once
  // (services/homeroom-bot-mayor.js decideOfferTap). It used to be the
  // button's label sent as a message from them, which the server read back.
  //
  //   POST /api/conversations/homeroom-bot/actions/:actionId  { choice, answers? }
  //   → 200 { ok, choice, label } | 409 { error: 'already_decided' | 'plan_gone' } | 404
  //
  // B6: `build` under a first version's plan, with `answers` (the choices
  // tapped, in order), from the DM's card or the App tab's.
  //
  // A browser's own tap only: same-origin, and on no connector's list
  // (services/cli-api-policy.js is fail-closed), so nothing but the person
  // in the app decides what the bot does for them.
  router.post('/api/conversations/homeroom-bot/actions/:actionId', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const actionId = Number(req.params.actionId);
      const choice = typeof req.body?.choice === 'string' ? req.body.choice : null;
      // B6: Build it under a plan carries the answers tapped, in order.
      const answers = Array.isArray(req.body?.answers)
        ? req.body.answers.slice(0, 2).map((a) => (typeof a === 'string' ? a.slice(0, 200) : null))
        : [];
      if (!Number.isInteger(actionId) || actionId <= 0) return res.status(404).json({ error: 'No such choice' });
      // The staging demo's offers are fixtures: there is nothing to decide.
      if (isDemo(req)) return res.json({ ok: true, choice, demo: true });
      const out = await require('../services/homeroom-bot-mayor').decideOfferTap(pool, config, { user: req.user, actionId, choice, answers });
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
      return res.json(out);
    } catch (err) {
      log.error('conversations', 'homeroom bot action failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Homeroom bot parity (P1-P9): a tap on one of the cards the bot puts
  // under a reply (its metadata's `card`: a batch, a confirm card, a gallery,
  // an investigation, …), decided on the server as the person in the
  // conversation, by the card type's handler (services/homeroom-bot-cards/).
  // A browser's own tap only, like the route above: same-origin, and on no
  // connector's list.
  //
  //   POST /api/conversations/homeroom-bot/cards/:messageId  { action, value? }
  //   → 200 { ok, ... } | 4xx { error }
  router.post('/api/conversations/homeroom-bot/cards/:messageId', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      // The staging demo's cards are fixtures: there is nothing to decide.
      if (isDemo(req)) return res.json({ ok: true, demo: true });
      const out = await require('../services/homeroom-bot-cards').decide(pool, config, {
        user: req.user, messageId: req.params.messageId, action: req.body?.action, value: req.body?.value,
      });
      if (!out.ok) return res.status(out.status || 400).json({ error: out.error || 'That did not work' });
      return res.json(out);
    } catch (err) {
      log.error('conversations', 'homeroom bot card tap failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Homeroom bot parity, P8: a picture Homeroom bot made in a chat
  // (services/bot-pictures.js), from the media store, for that chat's
  // members only. A gallery card's thumbnails and the image viewer read it.
  //
  //   GET /api/conversations/homeroom-bot/pictures/:id  → the image
  let pictureStore;
  router.get('/api/conversations/homeroom-bot/pictures/:id', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).end();
      const row = await require('../services/bot-pictures').imageForMember(pool, { userId: req.user.id, id: req.params.id });
      if (!row) return res.status(404).end();
      const media = require('../services/media-store');
      if (pictureStore === undefined) pictureStore = media.getStore(config);
      res.set('Content-Type', row.content_type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('Content-Length', String(row.bytes));
      if (req.method === 'HEAD') return res.end();
      return await media.respond(res, pictureStore, row);
    } catch (err) {
      log.error('conversations', 'homeroom bot picture read failed', { err: err.message, userId: req.user?.id });
      if (res.headersSent) return res.destroy();
      return res.status(500).end();
    }
  });

  // #5506: Withdraw it, from a ready card in the person's DM with the bot
  // (frontend/src/features/messages/bot-ready.tsx): one of the bot's own
  // proposals, still up for a vote, that they asked for or whose project
  // they own (homeroom-bot-mayor.js withdrawFromCard, the gates the DM's
  // "Withdraw it" offer keeps). Their tap only, as the route above.
  //
  //   POST /api/conversations/homeroom-bot/withdraw/:sessionId
  //   → 200 { ok } | 409 { error, code } (not theirs, or past withdrawing) | 404
  router.post('/api/conversations/homeroom-bot/withdraw/:sessionId', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const sessionId = Number(req.params.sessionId);
      if (!Number.isInteger(sessionId) || sessionId <= 0 || sessionId > 2147483647) return res.status(404).json({ error: 'No such change' });
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      // The staging demo's cards are fixtures: there is nothing to withdraw.
      if (isDemo(req)) return res.json({ ok: true, demo: true });
      const out = await require('../services/homeroom-bot-mayor').withdrawFromCard(pool, { user: req.user, sessionId });
      if (!out.ok) {
        return res.status(out.code === 'not_found' ? 404 : 409).json({ error: `Couldn't withdraw it: ${out.error}`, code: out.code });
      }
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'homeroom bot withdraw failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6019 (stage 5): a private thread's two doors, from the head of a
  // thread the person started in their chat with the bot
  // (frontend/src/features/messages/private-thread-bar.tsx,
  // services/private-threads.js). File it files its words as a request on
  // a project they pick; Post it posts them in an existing thread, by
  // number, as theirs. Each once, by their own tap: same-origin, on no
  // connector's list. A project they have not joined answers 403
  // join_required, which the client offers Join for.
  //
  //   GET  /api/conversations/homeroom-bot/threads/:rootId       → { state, kind?, number?, app?, target?, href?, mine }
  //   POST /api/conversations/homeroom-bot/threads/:rootId/file  { project, title?, text? }
  //   POST /api/conversations/homeroom-bot/threads/:rootId/post  { project, number, text? }
  const privateThreads = () => require('../services/private-threads');
  const threadRoot = (req) => {
    const id = Number(req.params.rootId);
    return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
  };
  const answerDoor = (res, out) => {
    if (out.ok) return res.json(out);
    const { ok: _ok, status, ...rest } = out;
    return res.status(status || 400).json(rest);
  };
  router.get('/api/conversations/homeroom-bot/threads/:rootId', async (req, res) => {
    try {
      const rootId = threadRoot(req);
      if (!rootId) return res.status(404).json({ error: 'No such thread' });
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      return res.json(await privateThreads().stateOf(pool, { user: req.user, rootId }));
    } catch (err) {
      log.error('conversations', 'private thread read failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  router.post('/api/conversations/homeroom-bot/threads/:rootId/file', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const rootId = threadRoot(req);
      if (!rootId) return res.status(404).json({ error: 'No such thread' });
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      return answerDoor(res, await privateThreads().fileIt(pool, config, {
        user: req.user, rootId,
        project: typeof body.project === 'string' ? body.project.slice(0, 120) : null,
        title: typeof body.title === 'string' ? body.title : null,
        text: typeof body.text === 'string' ? body.text : null,
      }));
    } catch (err) {
      log.error('conversations', 'private thread file failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  router.post('/api/conversations/homeroom-bot/threads/:rootId/post', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const rootId = threadRoot(req);
      if (!rootId) return res.status(404).json({ error: 'No such thread' });
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      return answerDoor(res, await privateThreads().postIt(pool, {
        user: req.user, rootId,
        project: typeof body.project === 'string' ? body.project.slice(0, 120) : null,
        number: Number(body.number),
        text: typeof body.text === 'string' ? body.text : null,
      }));
    } catch (err) {
      log.error('conversations', 'private thread post failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6071 follow-up: a new thread with the bot, from its "+"
  // (frontend/src/features/messages/new-thread.tsx): made when the person
  // sends its first message, with what the welcome block picked.
  //
  //   POST /api/conversations/homeroom-bot/new-thread   { project?, kind? } → { conversationId, rootId }
  router.post('/api/conversations/homeroom-bot/new-thread', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      return answerDoor(res, await privateThreads().startThread(pool, {
        user: req.user,
        project: typeof body.project === 'string' && body.project ? body.project.slice(0, 120) : null,
        kind: typeof body.kind === 'string' ? body.kind : 'any',
      }));
    } catch (err) {
      log.error('conversations', 'new bot thread failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #6071: design threads (services/design-threads.js). A screen the person
  // captured opens as a private thread of their chat with the bot; its pane
  // reads the thread and its versions here, and Propose it files the design
  // as a request with its plan. Every read is the owner's alone, and the
  // writes are their own taps: same-origin, on no connector's list.
  //
  //   POST /api/conversations/homeroom-bot/designs                          { html, surface, title, route?, appSlug?, width, height }
  //   GET  /api/conversations/homeroom-bot/designs/:rootId                  → the thread and its versions (no HTML)
  //   GET  /api/conversations/homeroom-bot/designs/:rootId/versions/:version → { version, html }
  //   POST /api/conversations/homeroom-bot/designs/:rootId/propose          { version?, title?, notes? }
  const designThreads = () => require('../services/design-threads');
  router.post('/api/conversations/homeroom-bot/designs', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      return answerDoor(res, await designThreads().startDesign(pool, config, {
        user: req.user,
        html: typeof body.html === 'string' ? body.html : '',
        surface: typeof body.surface === 'string' ? body.surface : '',
        title: typeof body.title === 'string' ? body.title : '',
        route: typeof body.route === 'string' ? body.route : null,
        appSlug: typeof body.appSlug === 'string' ? body.appSlug.slice(0, 120) : null,
        width: body.width,
        height: body.height,
      }));
    } catch (err) {
      log.error('conversations', 'design thread start failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  router.get('/api/conversations/homeroom-bot/designs/:rootId', async (req, res) => {
    try {
      const rootId = threadRoot(req);
      if (!rootId) return res.status(404).json({ error: 'No such design' });
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const design = await designThreads().designFor(pool, { userId: req.user.id, rootId });
      if (!design) return res.status(404).json({ error: 'No such design' });
      const { threadId: _threadId, ...shown } = design;
      // 1 Nov 2026 (C2.2): the request Propose it posts the plan on, when
      // the thread has one; null files a new request.
      const planOn = await designThreads().planTargetOf(pool, design).catch(() => null);
      return res.json({ ...shown, planOn });
    } catch (err) {
      log.error('conversations', 'design thread read failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  router.get('/api/conversations/homeroom-bot/designs/:rootId/versions/:version', async (req, res) => {
    try {
      const rootId = threadRoot(req);
      const version = Number(req.params.version);
      if (!rootId || !Number.isInteger(version) || version <= 0) return res.status(404).json({ error: 'No such version' });
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      const found = await designThreads().versionOf(pool, { userId: req.user.id, rootId, version });
      if (!found) return res.status(404).json({ error: 'No such version' });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ version: found.version, html: found.html });
    } catch (err) {
      log.error('conversations', 'design version read failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  router.post('/api/conversations/homeroom-bot/designs/:rootId/propose', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const rootId = threadRoot(req);
      if (!rootId) return res.status(404).json({ error: 'No such design' });
      if (!req.user?.id || req.user.isSynthetic) return res.status(403).json({ error: 'forbidden' });
      const body = req.body || {};
      const version = body.version == null ? null : Number(body.version);
      return answerDoor(res, await designThreads().proposeDesign(pool, config, {
        user: req.user, rootId,
        version: Number.isInteger(version) && version > 0 ? version : null,
        title: typeof body.title === 'string' ? body.title : null,
        notes: typeof body.notes === 'string' ? body.notes : null,
      }));
    } catch (err) {
      log.error('conversations', 'design propose failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Run six (14 Oct 2026): "We'll tell you when it's live" under a first
  // version's plan (frontend/src/features/messages/notify-me.tsx): whether
  // its maker is told when it is ready and live, on from Make it
  // (services/homeroom-bot-dm.js firstVersionNotify). The signed-in
  // person's own first version only: anybody else's, or a project with
  // none, is not found.
  //
  //   GET /api/conversations/homeroom-bot/first-versions/:slug/notify  → { on }
  //   PUT /api/conversations/homeroom-bot/first-versions/:slug/notify  { on } → { on }
  router.get('/api/conversations/homeroom-bot/first-versions/:slug/notify', async (req, res) => {
    try {
      // The staging demo's plan is a fixture: on, as every new one is.
      if (isDemo(req)) return res.json({ on: true, demo: true });
      const on = await require('../services/homeroom-bot-dm').firstVersionNotify(pool, { appSlug: req.params.slug, userId: req.user?.id });
      if (on === null) return res.status(404).json({ error: 'No such first version' });
      return res.json({ on });
    } catch (err) {
      log.error('conversations', 'first version notify read failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/conversations/homeroom-bot/first-versions/:slug/notify', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    try {
      const on = req.body?.on;
      if (typeof on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' });
      if (isDemo(req)) return res.json({ on, demo: true });
      const now = await require('../services/homeroom-bot-dm').setFirstVersionNotify(pool, { appSlug: req.params.slug, userId: req.user?.id, on });
      if (now === null) return res.status(404).json({ error: 'No such first version' });
      return res.json({ on: now });
    } catch (err) {
      log.error('conversations', 'first version notify write failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3660: what the Homeroom links in a message are, for this viewer.
  //
  //   POST /api/link-cards  { refs: [{ type, app_slug, issue_number |
  //                                    session_id | proposal_id }, …] }
  //   → 200 { cards: [card | { type, available: false }, …] }  (in order)
  //
  // A DM and an app's discussion both ask, so it is not under either one's
  // prefix. The client parsed each ref out of a link to this platform's own
  // address (frontend/src/features/messages/homeroom-links.ts); this answers
  // each through services/shared-objects.js `hydrateLink`, under the same
  // view rules as a shared card, so a reader gets a card only for a page
  // they can open. A POST because a list of refs is a body, not a query; it
  // reads and writes nothing else. Still same-origin only, as every unsafe
  // verb here is (middleware/same-site-browser.js): a page on a sibling
  // subdomain has no business asking what this viewer can see.
  router.post('/api/link-cards', linkCardLimiter, sameOriginBrowserOnly, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const refs = req.body?.refs;
    if (!Array.isArray(refs) || refs.length > sharedObjects.MAX_LINK_CARDS) {
      return res.status(400).json({ error: `refs must be a list of at most ${sharedObjects.MAX_LINK_CARDS} links` });
    }
    try {
      return res.json({ cards: await sharedObjects.hydrateLinks(pool, req.user, refs) });
    } catch (err) {
      log.error('conversations', 'link cards failed', { err: err.message, userId: req.user?.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations', conversationInviteLimiter, async (req, res) => {
    try {
      const result = req.body?.kind === 'direct'
        ? await conversations.createDirect(pool, req.user, conversations.strictId(req.body.user_id))
        : req.body?.kind === 'group'
          ? await conversations.createGroup(pool, req.user, req.body.title, req.body.member_ids, req.body?.invite_note)
          : null;
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: result.conversationId });
      return res.status(201).json({ conversation: result.conversation });
    } catch (err) {
      if (err instanceof contactPrivacy.ContactRestrictedError) return sendContactRestricted(res);
      log.error('conversations', 'create failed', { err: err.message, userId: req.user.id });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/conversations/:id', async (req, res) => {
    let id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      if (isDemo(req)) id = await stagingMessages.resolveLegacyLink(pool, req.user, id);
      const conversation = await conversations.getConversation(pool, req.user, id);
      return conversation ? res.json({ conversation }) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'get failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/conversations/:id', conversationActionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const conversation = await conversations.updateTitle(pool, req.user, id, req.body?.title);
      if (!conversation) return sendNotFound(res);
      const memberIds = await conversations.activeMemberIds(pool, id);
      pushAudience(memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ conversation });
    } catch (err) {
      log.error('conversations', 'update failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/respond', conversationSafetyLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.respond(pool, req.user, id, req.body?.action);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      // The invite row is now read, and a declined direct request archives
      // the conversation, which hides its rows from the inviter's count too.
      pushNotificationsChanged([req.user.id, ...(result.memberIds || [])]);
      return res.json({ conversation: result.conversation, status: req.body.action === 'accept' ? 'member' : 'declined' });
    } catch (err) {
      log.error('conversations', 'respond failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/members', conversationInviteLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.addMembers(pool, req.user, id, req.body?.user_ids, req.body?.invite_note);
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      return res.json({ conversation: result.conversation });
    } catch (err) {
      if (err instanceof contactPrivacy.ContactRestrictedError) return sendContactRestricted(res);
      log.error('conversations', 'add members failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/conversations/:id/members/:userId', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const targetId = conversations.strictId(req.params.userId);
    if (!id || !targetId) return sendNotFound(res);
    try {
      const result = await conversations.removeMember(pool, req.user, id, targetId);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      // The removed member's rows for this conversation were deleted.
      // (Removing yourself is a leave, whose audience includes you.)
      pushNotificationsChanged(targetId === req.user.id ? result.memberIds : [targetId]);
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'remove member failed', { id, targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/leave', conversationSafetyLimiter, sameOriginBrowserOnly, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const result = await conversations.leave(pool, req.user, id);
      if (!result) return sendNotFound(res);
      pushAudience(result.memberIds, { type: 'conversation_membership_changed', conversationId: id });
      // The leaver's rows were deleted; a direct conversation (or a group
      // whose last member left) is archived, which hides the rest of the
      // audience's rows for it, and pending invites to it are deleted.
      pushNotificationsChanged(result.memberIds);
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'leave failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/conversations/:id/messages', async (req, res) => {
    let id = conversations.strictId(req.params.id);
    const before = req.query.before == null ? null : conversations.strictId(req.query.before);
    // #2387: `after` pages forward from a permalink window; `around` opens
    // that window. At most one cursor per request.
    const after = req.query.after == null ? null : conversations.strictId(req.query.after);
    const around = req.query.around == null ? null : conversations.strictId(req.query.around);
    const cursors = [req.query.before, req.query.after, req.query.around].filter((v) => v != null);
    if (!id || (req.query.before != null && !before) || (req.query.after != null && !after)
        || (req.query.around != null && !around) || cursors.length > 1) return sendNotFound(res);
    try {
      if (isDemo(req)) id = await stagingMessages.resolveLegacyLink(pool, req.user, id);
      const options = { before, after, around, limit: req.query.limit };
      if (isDemo(req)) {
        for (const cursor of ['before', 'after', 'around']) {
          options[cursor] = await stagingMessages.resolveLegacyMessageLink(pool, req.user, id, options[cursor]);
        }
      }
      const page = await conversations.listMessages(pool, req.user, id, options);
      return page ? res.json(page) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'messages list failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2387: one thread — its root and a page of replies, oldest first.
  router.get('/api/conversations/:id/threads/:rootId', async (req, res) => {
    let id = conversations.strictId(req.params.id);
    let rootId = conversations.strictId(req.params.rootId);
    let before = req.query.before == null ? null : conversations.strictId(req.query.before);
    if (!id || !rootId || (req.query.before != null && !before)) return sendNotFound(res);
    try {
      if (isDemo(req)) {
        id = await stagingMessages.resolveLegacyLink(pool, req.user, id);
        rootId = await stagingMessages.resolveLegacyMessageLink(pool, req.user, id, rootId);
        before = await stagingMessages.resolveLegacyMessageLink(pool, req.user, id, before);
      }
      const thread = await conversations.listThread(pool, req.user, id, rootId, {
        before, limit: req.query.limit,
      });
      if (thread?.error === 'threads_not_supported') return res.status(400).json(THREADS_NOT_SUPPORTED);
      return thread ? res.json(thread) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'thread list failed', { id, rootId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #3361: the `@` list for a conversation whose roster the client does not
  // hold — a channel, which is counted, not loaded. `?q=` is a username
  // prefix and `?limit=` at most 25. The service answers null exactly when
  // listMessages would (same membership + read check), so a room the caller
  // cannot read is the same 404 either way. A per-keystroke typeahead over
  // people, so it shares the user-directory searches' per-user bucket.
  router.get('/api/conversations/:id/mention-candidates', userDirectoryLimiter, async (req, res) => {
    let id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      if (isDemo(req)) id = await stagingMessages.resolveLegacyLink(pool, req.user, id);
      const users = await conversations.mentionCandidates(pool, req.user, id, {
        q: req.query.q, limit: req.query.limit,
      });
      return users ? res.json({ users }) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'mention candidates failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages', conversationMessageLimiter, async (req, res) => {
    let id = conversations.strictId(req.params.id);
    if (!id) return sendNotFound(res);
    try {
      const input = { ...req.body };
      if (isDemo(req)) {
        id = await stagingMessages.resolveLegacyLink(pool, req.user, id);
        for (const key of ['thread_root_id', 'reply_to_id']) {
          if (Number.isInteger(input[key])) input[key] = await stagingMessages.resolveLegacyMessageLink(pool, req.user, id, input[key]);
        }
      }
      // #general is the Homeroom community's channel: posting in it, a reply
      // thread included, is for that community's members (reading is not).
      const join = await communities.generalNeedsJoin(pool, id, req.user, config?.selfAppSlug);
      if (join) return res.status(403).json(join);
      // #3624: a message to the Homeroom bot is owed an answer: the person's
      // DM machine hears it in the message's own transaction
      // (src/workflow/bot-dm/), and its work answers, wherever it runs. The
      // message is sent whatever the bot does with it.
      // #6071: a comment pinned on a design's preview carries its point,
      // checked against the person's own design thread it is written in.
      let metadata = null;
      if (input.design_pin != null) {
        const pin = await require('../services/design-threads').pinFor(pool, {
          user: req.user, conversationId: id, threadRootId: input.thread_root_id, pin: input.design_pin,
        });
        if (!pin) return res.status(400).json({ error: 'That comment\'s point is not on this design.' });
        metadata = { designPin: pin };
      }
      delete input.design_pin;
      const result = await conversations.sendMessage(pool, req.user, id, input, {
        metadata,
        afterInsert: (db, sent) => require('../services/homeroom-bot-dm').heardInDm(db, {
          user: req.user, conversationId: id, messageId: sent.messageId, membership: sent.membership, memberIds: sent.memberIds,
        }),
      });
      if (result?.error) return sendMessageError(res, result.error);
      if (!result) return sendNotFound(res);
      if (!result.duplicate) {
        await pushNotifications(pool, result.notifications);
        await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
          pushAudience(memberIds, {
            // Object cards are hydrated against one viewer. Never broadcast
            // the sender-authorized card payload to other members; recipients
            // refetch the thread through their own membership/object gates.
            type: 'conversation_message_created', conversationId: id, messageId: result.message.id,
            // #2387: which thread it joined (null: the main stream).
            threadRootId: result.message.threadRootId,
          }, { actorUserId: req.user.id });
        });
      }
      return res.status(result.duplicate ? 200 : 201).json({ message: result.message, duplicate: result.duplicate });
    } catch (err) {
      log.error('conversations', 'send failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/conversations/:id/messages/:messageId', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.editMessage(pool, req.user, id, messageId, req.body?.content);
      if (result?.error) return sendMessageError(res, result.error);
      if (!result) return sendNotFound(res);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_message_updated', conversationId: id, messageId: result.message.id,
          threadRootId: result.message.threadRootId,
        }, { actorUserId: req.user.id });
      });
      return res.json({ message: result.message });
    } catch (err) {
      log.error('conversations', 'edit failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2387: delete your own message. Soft: the row stays as a placeholder so
  // its thread and any quote of it keep their place; see
  // services/conversations.js deleteMessage for what goes with it.
  router.delete('/api/conversations/:id/messages/:messageId', conversationMessageLimiter, sameOriginBrowserOnly, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.deleteMessage(pool, req.user, id, messageId);
      if (!result) return sendNotFound(res);
      if (result.changed) {
        await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
          pushAudience(memberIds, {
            type: 'conversation_message_updated', conversationId: id, messageId,
            threadRootId: result.threadRootId,
          }, { actorUserId: req.user.id });
        });
        // Their bells lost a row (and possibly a queued push): recount.
        const { pushToUser } = require('../services/ws');
        for (const userId of result.notifiedUserIds) pushToUser(userId, { type: 'notifications_changed' });
      }
      return res.json({ message: result.message });
    } catch (err) {
      log.error('conversations', 'delete failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages/:messageId/reactions', conversationReactionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.toggleReaction(pool, req.user, id, messageId, req.body?.emoji);
      if (result?.error) return sendMessageError(res, result.error);
      if (!result) return sendNotFound(res);
      await pushNotifications(pool, result.notifications);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_reaction_updated', conversationId: id, messageId,
        }, { actorUserId: req.user.id });
      });
      pushNotificationsChanged(result.clearedUserIds);
      return res.json({ reactions: result.reactions });
    } catch (err) {
      log.error('conversations', 'reaction failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #1280, extended to the Messages area: save/unsave one message.
  //
  // PUT saves, DELETE unsaves — the same verbs and the same optimistic
  // client contract the app-chat bookmark has carried since #1280, so the two
  // surfaces behave identically. Both go through `readableMessage`, which is
  // a membership check: saving is a personal act that writes nothing anyone
  // else can see, but it still must not become a way to pin the content of a
  // conversation you are not in.
  //
  // No WebSocket broadcast, deliberately, and for the reason the app-chat
  // toggle has none: a save is private to one user, so there is no audience
  // to tell. It is not rate-limited as a mutation of the conversation either
  // — it mutates only the saver's own list — but it takes the reaction
  // limiter because it is a tap-repeatable button and that is the shape of
  // abuse it could carry.
  // The same two-part gate `listMessages` opens a conversation's history
  // with: a current membership, and — for a direct conversation — a peer
  // neither side has blocked. Then the message must actually belong to that
  // conversation, so a readable id from one cannot be used to save a message
  // out of another.
  async function readableMessage(user, conversationId, messageId) {
    const membership = await conversations.loadMembership(pool, conversationId, user.id, { allowDeletedPeer: true });
    if (!membership) return null;
    if (!await conversations.canReadConversation(pool, membership, user.id)) return null;
    return conversations.getMessage(pool, user, conversationId, messageId);
  }

  router.put(
    '/api/conversations/:id/messages/:messageId/bookmark',
    conversationReactionLimiter,
    sameOriginBrowserOnly,
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      const messageId = conversations.strictId(req.params.messageId);
      if (!id || !messageId) return sendNotFound(res);
      try {
        const message = await readableMessage(req.user, id, messageId);
        if (!message) return sendNotFound(res);
        // #2387: there is nothing left of a deleted message to keep.
        if (message.deleted) return sendMessageError(res, 'message_deleted');
        await messageBookmarks.saveConversationMessage(pool, req.user.id, messageId);
        return res.json({ saved: true });
      } catch (err) {
        log.error('conversations', 'bookmark save failed', { id, messageId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.delete(
    '/api/conversations/:id/messages/:messageId/bookmark',
    conversationReactionLimiter,
    sameOriginBrowserOnly,
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      const messageId = conversations.strictId(req.params.messageId);
      if (!id || !messageId) return sendNotFound(res);
      try {
        // Unsave needs no readability check: it only ever deletes THIS user's
        // own row, and a viewer who has since left the conversation must
        // still be able to clear what they saved from it.
        await messageBookmarks.removeConversationMessage(pool, req.user.id, messageId);
        return res.json({ saved: false });
      } catch (err) {
        log.error('conversations', 'bookmark remove failed', { id, messageId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post('/api/conversations/:id/read', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.body?.message_id);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.markRead(pool, req.user, id, messageId);
      if (!result) return sendNotFound(res);
      await conversations.withLockedAudience(pool, req.user, id, (memberIds) => {
        pushAudience(memberIds, {
          type: 'conversation_read', conversationId: id,
          userId: req.user.id, messageId: result.messageId,
          // #2387: set when a THREAD was read up to message_id; the
          // main-stream cursor (messageId) did not move.
          threadRootId: result.threadRootId || null,
        }, { actorUserId: req.user.id });
      });
      // #2904: reading a conversation clears its message notifications, but
      // announces itself as `conversation_read`, not `notifications_changed`
      // — so re-badge the reader's iPhone here explicitly.
      try { require('../services/mobile-push').scheduleBadgeSync(req.user.id); } catch {}
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'mark read failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2387: mark unread from a message. The cursor only moves back; the
  // answer is the conversation's new unread count, and the reader's own tabs
  // hear it as a `conversation_read` flagged `unread`.
  router.post('/api/conversations/:id/unread', conversationMessageLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.body?.message_id);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.markUnread(pool, req.user, id, messageId);
      if (!result) return sendNotFound(res);
      pushAudience([req.user.id], {
        type: 'conversation_read', conversationId: id,
        userId: req.user.id, messageId: result.messageId, unread: true,
      }, { actorUserId: req.user.id });
      return res.json({ unreadCount: result.unreadCount });
    } catch (err) {
      log.error('conversations', 'mark unread failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/typing', conversationReactionLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    if (!id || typeof req.body?.typing !== 'boolean') return sendNotFound(res);
    // 31 Oct 2026: typing in a thread names it, so the line is drawn there.
    const rawRoot = req.body?.thread_root_id;
    const threadRootId = rawRoot == null ? null : conversations.strictId(rawRoot);
    if (rawRoot != null && !threadRootId) return sendNotFound(res);
    try {
      const memberIds = await conversations.withLockedAudience(pool, req.user, id, (audience) => {
        pushAudience(audience, {
          type: 'conversation_typing', conversationId: id,
          userId: req.user.id, typing: req.body.typing,
          ...(threadRootId ? { threadRootId } : {}),
        }, { excludeUserId: req.user.id, actorUserId: req.user.id });
      });
      if (!memberIds) return sendNotFound(res);
      return res.status(204).end();
    } catch (err) {
      log.error('conversations', 'typing failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/conversations/:id/messages/:messageId/report', conversationReportLimiter, async (req, res) => {
    const id = conversations.strictId(req.params.id);
    const messageId = conversations.strictId(req.params.messageId);
    if (!id || !messageId) return sendNotFound(res);
    try {
      const result = await conversations.reportMessage(
        pool, req.user, id, messageId, req.body?.reason, req.body?.detail
      );
      if (result?.error) return sendMessageError(res, result.error);
      return result ? res.status(202).json({ ok: true }) : sendNotFound(res);
    } catch (err) {
      log.error('conversations', 'report failed', { id, messageId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/conversations/:id/attachments',
    attachmentUploadLimiter,
    sameOriginBrowserOnly,
    express.raw({ type: '*/*', limit: '21mb' }),
    async (req, res) => {
      const id = conversations.strictId(req.params.id);
      if (!id) return sendNotFound(res);
      try {
        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const ext = attachments.fileExt(filename);
        let verdict = ext === 'zip'
          ? attachments.validateUpload({ filename, data })
          : attachments.validateChatUpload({ filename, data });
        if (verdict.ok && verdict.kind === 'zip') {
          verdict = { ...verdict, kind: 'binary' };
        }
        if (verdict.ok && ext !== 'zip' && verdict.kind !== 'image'
            && attachments.isUtf8Text(data)
            && data.length > MAX_CONVERSATION_TEXT_BYTES) {
          verdict = { ok: false, error: 'Text/code/Markdown/HTML files must be 200 KB or smaller' };
        }
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });
        const attachmentId = crypto.randomBytes(16).toString('hex');
        const stored = await conversations.transaction(pool, async (db) => {
          const membership = await conversations.lockInteractionMembership(db, id, req.user.id);
          if (!membership) return null;
          // All uploads take these quota locks in the same order. The SUM and
          // INSERT therefore form one serializable quota decision even when
          // requests for one user/conversation arrive concurrently.
          await db.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [`conversation-attachment-quota:${id}`]
          );
          await db.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [`user-attachment-quota:${req.user.id}`]
          );
          const { rows } = await db.query(
            `SELECT
               COALESCE(SUM(size_bytes) FILTER (WHERE conversation_id = $1), 0)::bigint AS conversation_total,
               COALESCE(SUM(size_bytes) FILTER (WHERE user_id = $2), 0)::bigint AS user_total
             FROM conversation_message_attachments`,
            [id, req.user.id]
          );
          const totals = rows[0];
          if (Number(totals.conversation_total) + data.length > MAX_CONVERSATION_ATTACHMENT_BYTES
              || Number(totals.user_total) + data.length > MAX_USER_ATTACHMENT_BYTES) {
            return { full: true };
          }
          await db.query(
            `INSERT INTO conversation_message_attachments
               (id, conversation_id, user_id, kind, filename, content_type, size_bytes, meta, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [attachmentId, id, req.user.id, verdict.kind, filename, verdict.contentType,
             data.length, verdict.meta ? JSON.stringify(verdict.meta) : null, data]
          );
          return { full: false };
        });
        if (!stored) return sendNotFound(res);
        if (stored.full) {
          return res.status(400).json({ error: 'Conversation attachment storage is full' });
        }
        const base = `/api/conversations/${id}/attachments/${attachmentId}`;
        return res.status(201).json({ attachment: {
          id: attachmentId, name: filename, size: data.length,
          contentType: verdict.contentType, kind: verdict.kind, meta: verdict.meta || null,
          url: base, viewUrl: verdict.kind === 'html' ? `${base}/view` : null,
        } });
      } catch (err) {
        log.error('conversations', 'attachment upload failed', { id, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  async function loadAttachment(req, res, { htmlOnly = false } = {}) {
    const id = conversations.strictId(req.params.id);
    const attachmentId = String(req.params.attachmentId || '');
    if (!id || !/^[a-f0-9]{32}$/.test(attachmentId)) return null;
    const membership = await conversations.loadMembership(pool, id, req.user.id, { allowDeletedPeer: true });
    if (!membership || !(await conversations.canReadConversation(pool, membership, req.user.id))) return null;
    // #2387: a deleted or moderator-hidden message's attachment survives only
    // as moderation evidence on a report (admin route below); members never
    // reach it.
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.filename, a.content_type, a.data, a.message_id, a.user_id
         FROM conversation_message_attachments a
        WHERE a.id = $1 AND a.conversation_id = $2
          AND NOT EXISTS (SELECT 1 FROM conversation_messages m
                           WHERE m.id = a.message_id
                             AND (m.deleted_at IS NOT NULL OR m.moderation_hidden_at IS NOT NULL))`,
      [attachmentId, id]
    );
    const row = rows[0];
    if (!row || (htmlOnly && row.kind !== 'html')) return null;
    if (row.message_id == null && row.user_id !== req.user.id) return null;
    if (row.message_id != null && row.user_id !== req.user.id) {
      const { rows: blocks } = await pool.query(
        `SELECT 1 FROM user_blocks
          WHERE blocker_id = $1 AND blocked_user_id = $2 LIMIT 1`,
        [req.user.id, row.user_id]
      );
      if (blocks.length) return null;
    }
    return row;
  }

  router.get('/api/conversations/:id/attachments/:attachmentId', async (req, res) => {
    try {
      const row = await loadAttachment(req, res);
      if (!row) return res.status(404).end();
      const inline = row.kind === 'image';
      const contentType = inline
        ? (row.content_type || 'application/octet-stream')
        : row.kind === 'binary'
          ? (row.content_type === 'application/zip' ? 'application/zip' : 'application/octet-stream')
          : 'text/plain; charset=utf-8';
      res.set('Content-Type', contentType);
      // The stored filename is arbitrary UTF-8, and a header value may only
      // carry Latin-1: build the header through the shared helper rather
      // than interpolating the name, or res.set() throws and the response
      // becomes a 500 (#2113).
      res.set('Content-Disposition', attachments.attachmentDisposition(
        inline ? 'inline' : 'attachment', row.filename
      ));
      return res.send(row.data);
    } catch (err) {
      log.error('conversations', 'attachment download failed', { err: err.message });
      return res.status(500).end();
    }
  });

  router.get('/api/conversations/:id/attachments/:attachmentId/view', async (req, res) => {
    try {
      const row = await loadAttachment(req, res, { htmlOnly: true });
      if (!row) return res.status(404).end();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('Content-Disposition', attachments.attachmentDisposition('inline', row.filename || 'file.html'));
      return res.send(row.data);
    } catch (err) {
      log.error('conversations', 'attachment view failed', { err: err.message });
      return res.status(500).end();
    }
  });

  router.get('/api/me/blocks', async (req, res) => {
    try {
      return res.json({ users: await conversations.listBlocks(pool, req.user.id) });
    } catch (err) {
      log.error('conversations', 'block list failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/me/blocks/:userId', conversationSafetyLimiter, sameOriginBrowserOnly, async (req, res) => {
    const targetId = conversations.strictId(req.params.userId);
    if (!targetId) return sendNotFound(res);
    try {
      const result = await conversations.setBlock(pool, req.user.id, targetId, true);
      if (!result) return sendNotFound(res);
      for (const audience of result.conversationAudiences || []) {
        pushAudience(audience.memberIds, {
          type: 'conversation_membership_changed', conversationId: audience.conversationId,
        });
      }
      for (const conversationId of result.privateRefreshConversationIds || []) {
        pushAudience([req.user.id], { type: 'conversation_membership_changed', conversationId });
      }
      const { pushToUser } = require('../services/ws');
      for (const userId of result.memberIds) pushToUser(userId, { type: 'notifications_changed' });
      pushToUser(req.user.id, { type: 'user_blocks_changed', userId: targetId, blocked: true });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'block failed', { targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/blocks/:userId', conversationSafetyLimiter, sameOriginBrowserOnly, async (req, res) => {
    const targetId = conversations.strictId(req.params.userId);
    if (!targetId) return sendNotFound(res);
    try {
      const result = await conversations.setBlock(pool, req.user.id, targetId, false);
      if (!result) return sendNotFound(res);
      for (const audience of result.conversationAudiences || []) {
        pushAudience(audience.memberIds, {
          type: 'conversation_membership_changed', conversationId: audience.conversationId,
        });
      }
      for (const conversationId of result.privateRefreshConversationIds || []) {
        pushAudience([req.user.id], { type: 'conversation_membership_changed', conversationId });
      }
      const { pushToUser } = require('../services/ws');
      for (const userId of result.memberIds) pushToUser(userId, { type: 'notifications_changed' });
      pushToUser(req.user.id, { type: 'user_blocks_changed', userId: targetId, blocked: false });
      return res.json({ ok: true });
    } catch (err) {
      log.error('conversations', 'unblock failed', { targetId, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Private moderation queue. View-only admins may inspect retained evidence;
  // resolving/dismissing is a privileged write with resolver attribution.
  router.use('/api/admin/conversation-reports', privateJson);

  async function loadReportedAttachment(req, { htmlOnly = false } = {}) {
    const reportId = conversations.strictId(req.params.id);
    const attachmentId = String(req.params.attachmentId || '');
    if (!reportId || !/^[a-f0-9]{32}$/.test(attachmentId)) return null;
    const { rows } = await pool.query(
      `SELECT a.id, a.kind, a.filename, a.content_type, a.data
         FROM conversation_message_reports r
         JOIN conversation_message_attachments a
           ON a.conversation_id = r.conversation_id
          AND a.message_id = r.message_id
        WHERE r.id = $1 AND a.id = $2`,
      [reportId, attachmentId]
    );
    const row = rows[0] || null;
    return row && (!htmlOnly || row.kind === 'html') ? row : null;
  }

  router.get(
    '/api/admin/conversation-reports/:id/attachments/:attachmentId',
    adminMiddleware,
    async (req, res) => {
      try {
        const row = await loadReportedAttachment(req);
        if (!row) return res.status(404).end();
        const inline = row.kind === 'image';
        res.set('Content-Type', inline ? row.content_type : 'application/octet-stream');
        res.set('Content-Disposition', attachments.attachmentDisposition(
          inline ? 'inline' : 'attachment', row.filename || 'evidence'
        ));
        return res.send(row.data);
      } catch (err) {
        log.error('conversations', 'report attachment failed', { err: err.message });
        return res.status(500).end();
      }
    }
  );

  router.get(
    '/api/admin/conversation-reports/:id/attachments/:attachmentId/view',
    adminMiddleware,
    async (req, res) => {
      try {
        const row = await loadReportedAttachment(req, { htmlOnly: true });
        if (!row) return res.status(404).end();
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Content-Security-Policy', 'sandbox allow-scripts');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Content-Disposition', attachments.attachmentDisposition('inline', row.filename || 'evidence.html'));
        return res.send(row.data);
      } catch (err) {
        log.error('conversations', 'report attachment view failed', { err: err.message });
        return res.status(500).end();
      }
    }
  );

  router.get('/api/admin/conversation-reports', adminMiddleware, async (req, res) => {
    const status = ['pending', 'resolved', 'dismissed'].includes(req.query.status)
      ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.conversation_id, r.message_id, r.reason, r.detail,
                r.content_snapshot, r.evidence_snapshot, r.status,
                r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                reported.username AS reported_username,
                resolver.username AS resolved_by_username
           FROM conversation_message_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users reported ON reported.id = r.reported_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1
          ORDER BY r.created_at ASC, r.id ASC
          LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('conversations', 'report queue failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/admin/conversation-reports/:id/:action',
    adminMiddleware,
    requireAdminWrite,
    async (req, res) => {
      const reportId = conversations.strictId(req.params.id);
      const status = req.params.action === 'resolve'
        ? 'resolved' : req.params.action === 'dismiss' ? 'dismissed' : null;
      if (!reportId || !status) return res.status(404).json({ error: 'Pending report not found' });
      try {
        const { rows } = await pool.query(
          `UPDATE conversation_message_reports
              SET status = $1, resolved_at = NOW(), resolved_by = $2
            WHERE id = $3 AND status = 'pending'
            RETURNING id, status, resolved_at`,
          [status, req.user.id, reportId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Pending report not found' });
        log.info('conversations', 'Conversation report moderated', {
          reportId, status, by: req.user.username,
        });
        return res.json({ report: rows[0] });
      } catch (err) {
        log.error('conversations', 'report moderation failed', { reportId, err: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  return router;
}

module.exports = {
  conversationRoutes,
  privateJson,
  demoConversations: stagingMessages.demoConversations,
  demoMessages: stagingMessages.demoMessages,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_USER_ATTACHMENT_BYTES,
};
