'use strict';

/**
 * Invite links over HTTP (services/community-invites.js has the rules).
 *
 *   POST   /api/apps/:slug/invite-links            make a link
 *   GET    /api/apps/:slug/invite-links            your live links (every
 *                                                  live link, for someone
 *                                                  who manages the project)
 *   DELETE /api/invite-links/:id                   turn one off
 *   GET    /api/public/invites/:token              the preview, signed out
 *   GET    /api/invite-links/by-token/:token       the preview plus where
 *                                                  the viewer stands on it
 *   POST   /api/invite-links/by-token/:token/redeem  follow it
 *   GET    /api/invite-links/queued                the communities a person
 *                                                  still waiting is queued for
 *   GET    /invite/:token                          the page: the shell, with
 *                                                  a link preview in its head
 *
 * The by-token routes and `queued` are open to a signed-in account without
 * platform access (GATE_OPEN_PATHS in middleware/auth.js): following a link
 * from the waiting room is how somebody still waiting queues a community.
 * Everything else a link does is behind the gate like the rest of the API.
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const invites = require('../services/community-invites');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { applyShellDocumentHeaders, shellAssetCacheControl } = require('../services/static-cache');
const {
  inviteLinkCreateLimiter, inviteRedeemLimiter, invitePreviewLimiter,
} = require('../middleware/rate-limits');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The link-preview tags for an invite page: what iMessage, Slack and the
 * rest show when the link is pasted. A live link names the project, who
 * invited you and its icon; a dead or unknown one says only that it is a
 * Homeroom invite, so a pasted link discloses no more than preview() does.
 */
function previewTags(preview, origin) {
  const live = preview && preview.live;
  const name = live ? preview.project.name : null;
  const title = live ? `Join ${name} on Homeroom` : 'Homeroom invite';
  const members = live && preview.memberCount
    ? ` ${preview.memberCount} ${preview.memberCount === 1 ? 'person is' : 'people are'} in it.`
    : '';
  const description = live
    ? `${preview.inviter ? `@${preview.inviter} invited you to ${name}.` : `You are invited to ${name}.`}${members}`
    : 'This invite link is no longer active.';
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Homeroom">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ];
  if (live && preview.project.iconUrl && origin) {
    tags.push(`<meta property="og:image" content="${escapeAttr(origin + preview.project.iconUrl)}">`);
  }
  return tags.join('\n');
}

/** The shell document with `tags` placed in its head. */
function withPreviewTags(html, tags) {
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  return `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}

// The origin the page was asked for, for the icon's absolute URL (a preview
// image must be absolute). The Host a request arrives with only shapes the
// answer to that same request, so there is nobody else it could mislead.
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^https?$/.test(proto) && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) ? `${proto}://${host}` : null;
}

function communityInviteRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const appColumns = `${appAccess.ACCESS_COLUMNS}, community_id, name`;

  router.post('/api/apps/:slug/invite-links', drainGuard, inviteLinkCreateLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appColumns);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const made = await invites.createInvite(pool, {
        app, user: req.user, days: req.body?.days, maxUses: req.body?.maxUses,
      });
      if (!made.ok) return res.status(made.status).json({ error: made.error });
      log.info('invites', 'Invite link made', { slug: app.slug, by: req.user.username, id: made.link.id });
      return res.status(201).json({ link: made.link });
    } catch (err) {
      log.error('invites', 'Making an invite link failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/invite-links', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appColumns);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const [listed, canCreate, skipsLeft] = await Promise.all([
        invites.listInvites(pool, { app, user: req.user }),
        invites.canCreate(pool, app, req.user),
        invites.skipsLeft(pool, req.user),
      ]);
      return res.json({
        links: listed.links,
        manages: listed.manages,
        canCreate,
        grant: invites.grantFor(app),
        defaults: { days: invites.DEFAULT_DAYS, maxUses: invites.DEFAULT_USES },
        limits: invites.LIMITS,
        skipsLeft,
      });
    } catch (err) {
      log.error('invites', 'Listing invite links failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/invite-links/:id', drainGuard, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const done = await invites.revokeInvite(pool, { inviteId: req.params.id, user: req.user });
      if (!done.ok) return res.status(done.status).json({ error: done.error });
      return res.json({ ok: true, cancelled: done.cancelled });
    } catch (err) {
      log.error('invites', 'Turning off an invite link failed', { id: req.params.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Anonymous: under /api/public/, so authMiddleware never resolves a user
  // here, and the answer is the same whoever asks.
  router.get('/api/public/invites/:token', invitePreviewLimiter, async (req, res) => {
    try {
      const preview = await invites.preview(pool, req.params.token);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(preview.reason === 'unknown' ? 404 : 200).json(preview);
    } catch (err) {
      log.error('invites', 'Invite preview failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/invite-links/queued', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      return res.json({ queued: await invites.queuedFor(pool, req.user.id) });
    } catch (err) {
      log.error('invites', 'Reading queued invites failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/invite-links/by-token/:token', invitePreviewLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const standing = await invites.standing(pool, req.params.token, req.user);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(standing.reason === 'unknown' ? 404 : 200).json(standing);
    } catch (err) {
      log.error('invites', 'Invite standing failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Only the Homeroom page itself may follow a link for a signed-in visitor
  // (middleware/same-site-browser.js).
  router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const result = await invites.redeem(pool, { token: req.params.token, user: req.user });
      // Following a link clears any copy the sign-in carried: it is spent.
      invites.clearInviteCookie(res);
      if (!result.ok) return res.status(result.status).json({ error: 'This invite link is not active.', reason: result.reason });
      return res.json(result);
    } catch (err) {
      log.error('invites', 'Following an invite link failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The page. The shell, as `app.get('*')` serves it, with the link preview
  // in its head for whatever unfurls the link; the shell itself routes the
  // path (App.restoreFromHash). The token rides in an HttpOnly cookie too,
  // so signing up or in from here follows it server-side
  // (communityInvites.redeemCarried, in routes/auth.js).
  router.get('/invite/:token', invitePreviewLimiter, async (req, res, next) => {
    if (!req.accepts('html')) return next();
    const token = req.params.token;
    try {
      const preview = invites.isToken(token)
        ? await invites.preview(pool, token)
        : { live: false, reason: 'unknown' };
      if (preview.live) invites.setInviteCookie(req, res, token);
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      applyShellDocumentHeaders(res, INDEX_PATH);
      res.type('html').send(withPreviewTags(html, previewTags(preview, requestOrigin(req))));
    } catch (err) {
      log.error('invites', 'Serving an invite page failed', { err: err.message });
      if (!res.headersSent) {
        res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
        return res.sendFile(INDEX_PATH);
      }
    }
    return undefined;
  });

  return router;
}

module.exports = communityInviteRoutes;
module.exports.previewTags = previewTags;
module.exports.withPreviewTags = withPreviewTags;
module.exports.escapeAttr = escapeAttr;
