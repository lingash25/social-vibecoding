'use strict';

// Hosted MCP connector — transport, OAuth 2.1 server, and the browser-facing
// management surfaces.
//
// Three routers, mounted at different points in server.js because they have
// three different authentication contracts:
//
//   mcpConnectGate(config)      — hard staging / enablement 404, before any
//                                 body parser or credential lookup.
//   mcpPreAuthRoutes(config)    — public metadata, dynamic client
//                                 registration, the token + revocation
//                                 endpoints, the consent page SHELL, and
//                                 POST /mcp itself (bearer, never cookie).
//                                 Mounts BEFORE the cookie middleware.
//   mcpBrowserRoutes(config)    — the parts that need a platform session:
//                                 the consent decision, the connected-apps
//                                 list and disconnect. Mounts AFTER
//                                 authMiddleware.
//
// The split matters: /mcp must never fall back to an ambient cookie (that
// would let a logged-in browser tab drive the connector), and the consent
// POST must never accept a bearer (that would let a token approve itself).

const path = require('path');
const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');
const {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  MCP_PATH,
  CONSENT_PATH,
  TOKEN_RATE_PER_MINUTE,
  IP_RATE_PER_MINUTE,
  REGISTER_RATE_PER_MINUTE,
  SERVER_NAME,
  SERVER_VERSION,
  DELEGATED_TOKEN_PREFIX,
  DELEGATED_CLIENT_NAMES,
  DELEGATION_KINDS,
} = require('../services/mcp-connect-constants');
const mcpOauth = require('../services/mcp-oauth');
const mcpTools = require('../services/mcp-tools');
const { consumeSharedTokenBucket } = require('../services/cli-auth');

const CONSENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Every path this feature owns. The gate below 404s all of them wholesale
// on staging, before anything reads a body or a credential. The predicate
// itself lives in services/mcp-oauth.js so it carries no Express dependency
// and is unit-testable on its own.
function isConnectorSurface(req) {
  return mcpOauth.isConnectorSurfacePath(req.path);
}

// A staging preview derives its browser identity from an iframe token; if
// the connector existed there, a staging session could mint a credential
// good against production-shaped state. So the whole surface is production
// (or explicit local-dev) only, gated on validated deployment configuration
// rather than on the request's Host header.
function mcpConnectGate(config) {
  return (req, res, next) => {
    if (!isConnectorSurface(req)) return next();
    const staging = process.env.USERNODE_ENV === 'staging';
    // The read-only Settings connector status survives on staging so the
    // section is reviewable there from its ?demo=1 fixture; it never
    // touch real credential state (see the staging branches in their
    // handlers). Everything else — minting, presenting, revoking — is
    // dead. `!cliAuthEnabled` still 404s the whole surface.
    if (staging && mcpOauth.isStagingReadableConnectorPath(req.method, req.path)) {
      return next();
    }
    if (staging || !config.cliAuthEnabled) {
      // #2779: the one credential that survives here is a DELEGATED grant on
      // POST /mcp — minted in-process by this same deployment for its own
      // agents, so a staging preview can exercise agent sessions. Decided on
      // the method, the path and the bearer's shape alone; the handler still
      // refuses it unless it joins a live delegation.
      if (mcpOauth.isDelegatedMcpRequest(req.method, req.path, req.rawHeaders)) return next();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'not_found' });
    }
    return next();
  };
}

// Is the consent-based connector surface switched off in this deployment?
// The same condition the gate above 404s on, for the handler's second check.
function connectorSurfaceClosed(config) {
  return process.env.USERNODE_ENV === 'staging' || !config.cliAuthEnabled;
}

// Where the tool handlers' loopback calls go.
//
// In a real deployment that is the platform's own in-cluster address
// (PLATFORM_INTERNAL_URL, the same one services/worker.js uses to reach the
// internal API). In local development there is no `usernode` service name to
// resolve, so fall back to the deployment's configured canonical origin —
// which local mode has already validated as loopback. Production keeps the
// in-cluster address and never takes this branch.
function platformBaseUrl(config) {
  if (process.env.PLATFORM_INTERNAL_URL) return process.env.PLATFORM_INTERNAL_URL;
  if (config.cliAuthLocalMode && config.cliAuthOrigin) return config.cliAuthOrigin;
  return undefined; // services/mcp-tools.js applies the in-cluster default
}

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

async function enforceBucket(pool, res, options) {
  try {
    const state = await consumeSharedTokenBucket(pool, options);
    if (!state.allowed) {
      res.setHeader('Retry-After', String(state.retryAfter));
      res.status(429).json({ error: 'rate_limited' });
      return false;
    }
    return true;
  } catch {
    // The limiter is a control, not an optimisation: if it cannot run, the
    // request does not run either.
    res.status(503).json({ error: 'temporarily_unavailable' });
    return false;
  }
}

function jsonBody(limit) {
  return (req, res, next) => {
    express.json({ limit, strict: true })(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'invalid_request' });
      return next();
    });
  };
}

// Same-origin check for the browser-session endpoints, mirroring
// routes/cli-auth.js's browserCsrf. The comparison is against the
// deployment's CONFIGURED canonical origin, never a request header.
function browserCsrf(config, req, res) {
  if (req.headers.origin !== config.cliAuthOrigin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Exactly one syntactically valid Bearer credential (implementation in
// services/mcp-oauth.js, so it is testable without Express).
function readConnectorBearer(req) {
  return mcpOauth.readBearerFromRawHeaders(req.rawHeaders);
}

function resourceMetadataUrl(config) {
  return `${config.cliAuthOrigin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

// The 401 that makes Claude.ai / ChatGPT start the OAuth dance: without the
// resource_metadata pointer they have nowhere to discover the authorization
// server from.
function bearerChallenge(config, res, error) {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer error="${error}", resource_metadata="${resourceMetadataUrl(config)}"`
  );
  res.status(401).json({ error });
}

// Resolve a connector access token to a live user. Structurally the twin of
// activeTokenMiddleware in routes/cli-auth.js: reject revoked/expired, load
// the user from `users` (never trust anything carried on the token itself),
// write the audit row BEFORE dispatching, and update last_used_at
// monotonically as non-authoritative metadata.
//
// #2779: the same lookup serves a DELEGATED grant — the platform's own agent
// acting for the user — and returns it as `delegation`. The token's shape
// and its grant must agree: an `svmcd_…` token is honoured only with a live
// mcp_delegations row behind it, and an `svmcp_…` token never with one. A
// delegation is live while it is neither revoked nor expired and, when it
// names a change, while that change is still the user's and still open —
// so pausing or archiving the change ends a worker's token on its next call
// without anything having to revoke it. The same holds for the agent session
// a Mayor's grant names: archiving it ends the grant.
const WORKER_LIVE_CHANGE_STATUSES = Object.freeze(['active', 'promoted']);
const MAYOR_LIVE_CHANGE_STATUSES = Object.freeze(['active', 'paused', 'promoted', 'merging']);

function delegationRefusal(row) {
  if (row.d_revoked_at) return 'revoked_token';
  if (new Date(row.now) >= new Date(row.d_expires_at)) return 'expired_token';
  if (row.d_change_id != null) {
    const live = row.d_kind === 'worker_read' ? WORKER_LIVE_CHANGE_STATUSES : MAYOR_LIVE_CHANGE_STATUSES;
    if (row.change_user_id !== row.user_id || !live.includes(row.change_status)) return 'revoked_token';
    if (row.d_app_id != null && row.change_app_id !== row.d_app_id) return 'revoked_token';
  }
  if (row.d_app_id != null && !row.app_slug) return 'revoked_token';
  // #2779 step 3: a Mayor's grant serves one agent session, and ends when
  // that session is archived or is not the grant user's.
  if (row.d_agent_session_id != null
      && (row.agent_session_user_id !== row.user_id || row.agent_session_status !== 'open')) {
    return 'revoked_token';
  }
  return null;
}

async function authenticateConnector(pool, token) {
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.client_id, t.grant_id, t.scopes,
            t.expires_at, t.revoked_at, c.client_name,
            d.grant_id AS d_grant_id, d.kind AS d_kind,
            d.agent_session_id AS d_agent_session_id, d.change_id AS d_change_id,
            d.app_id AS d_app_id, d.expires_at AS d_expires_at,
            d.revoked_at AS d_revoked_at,
            a.slug AS app_slug,
            cs.user_id AS change_user_id, cs.status AS change_status,
            cs.app_id AS change_app_id,
            ags.user_id AS agent_session_user_id, ags.status AS agent_session_status,
            clock_timestamp() AS now
       FROM mcp_tokens t
       LEFT JOIN mcp_clients c ON c.client_id = t.client_id
       LEFT JOIN mcp_delegations d ON d.grant_id = t.grant_id
       LEFT JOIN apps a ON a.id = d.app_id
       LEFT JOIN chat_sessions cs ON cs.id = d.change_id
       LEFT JOIN agent_sessions ags ON ags.id = d.agent_session_id
      WHERE t.token_hash = $1 AND t.kind = 'access'`,
    [mcpOauth.hashSecret(token)]
  );
  if (!rows.length) return { error: 'invalid_token' };
  const row = rows[0];
  const presentedDelegated = String(token).startsWith(DELEGATED_TOKEN_PREFIX);
  if (presentedDelegated !== !!row.d_grant_id) return { error: 'invalid_token' };
  if (row.revoked_at) return { error: 'revoked_token' };
  if (new Date(row.now) >= new Date(row.expires_at)) return { error: 'expired_token' };
  if (row.d_grant_id) {
    if (!DELEGATION_KINDS.includes(row.d_kind)) return { error: 'invalid_token' };
    const refused = delegationRefusal(row);
    if (refused) return { error: refused };
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin, admin_readonly, app_quota, locale
       FROM users WHERE id = $1`,
    [row.user_id]
  );
  if (!userRows.length) return { error: 'invalid_token' };
  const user = userRows[0];

  const delegation = row.d_grant_id
    ? {
      kind: row.d_kind,
      grantId: row.d_grant_id,
      agentSessionId: row.d_agent_session_id ?? null,
      changeId: row.d_change_id ?? null,
      appId: row.d_app_id ?? null,
      appSlug: row.app_slug || null,
      expiresAt: new Date(row.d_expires_at),
    }
    : null;

  return {
    tokenId: row.id,
    grantId: row.grant_id,
    clientId: row.client_id,
    clientName: delegation
      ? DELEGATED_CLIENT_NAMES[delegation.kind]
      : (row.client_name || 'Unknown client'),
    scopes: row.scopes,
    now: new Date(row.now),
    delegation,
    user: {
      id: user.id,
      username: user.username,
      isAdmin: !!user.is_admin,
      adminReadonly: !!user.admin_readonly,
      canAdminWrite: !!user.is_admin && !user.admin_readonly,
      appQuota: user.app_quota ?? 0,
      locale: user.locale || null,
    },
  };
}

// Is this POST body the client opening a session?
//
// Deliberately shallow: it looks at the parsed body's `method`, and at each
// element's if the body is a JSON-RPC batch. It does NOT validate the
// envelope — the SDK does that a few lines later and is the only thing
// entitled to reject a message. All this decides is whether an advisory row
// gets armed, so a false negative costs a tip and a false positive costs a
// row that was going to be written on the next real initialize anyway.
function isInitializeRequest(body) {
  if (Array.isArray(body)) return body.some((entry) => isInitializeRequest(entry));
  return !!body && typeof body === 'object' && body.method === 'initialize';
}

// ── Router 1: gate + public/bearer surfaces ────────────────────────────

function mcpPreAuthRoutes(config) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const pool = getPool(config);

  router.use([
    MCP_PATH,
    CONSENT_PATH,
    '/api/connect',
    '/api/connect/*',
    '/api/me/connectors',
    '/api/me/connectors/*',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/*',
  ], noStore);

  // ── RFC 9728: protected-resource metadata ────────────────────────────
  // Served at both the bare path and the resource-suffixed path, because
  // clients differ on which they probe.
  const protectedResourceMetadata = (_req, res) => {
    res.json({
      resource: `${config.cliAuthOrigin}${MCP_PATH}`,
      authorization_servers: [config.cliAuthOrigin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Homeroom',
      resource_documentation: `${config.cliAuthOrigin}/`,
    });
  };
  router.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  router.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResourceMetadata);

  // ── RFC 8414: authorization-server metadata ──────────────────────────
  // S256 only and no implicit/password grants: this advertises exactly what
  // the token endpoint will actually accept.
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: config.cliAuthOrigin,
      authorization_endpoint: `${config.cliAuthOrigin}${CONSENT_PATH}`,
      token_endpoint: `${config.cliAuthOrigin}/api/connect/oauth/token`,
      registration_endpoint: `${config.cliAuthOrigin}/api/connect/oauth/register`,
      revocation_endpoint: `${config.cliAuthOrigin}/api/connect/oauth/revoke`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      service_documentation: `${config.cliAuthOrigin}/`,
    });
  });

  // ── RFC 7591: dynamic client registration ────────────────────────────
  //
  // Open to any caller but ALLOWLISTED by redirect host, and rate-limited
  // per IP. The platform is not trying to be a general-purpose OAuth
  // provider; the consent screen's only real defence against a lookalike
  // client is showing a redirect origin the user recognises, which only
  // works if unrecognisable ones are refused outright.
  router.post('/api/connect/oauth/register', jsonBody('4kb'), async (req, res) => {
    const ok = await enforceBucket(pool, res, {
      namespace: 'mcp-register-ip',
      subject: clientIp(req),
      ratePerMinute: REGISTER_RATE_PER_MINUTE,
      capacity: REGISTER_RATE_PER_MINUTE,
    });
    if (!ok) return undefined;

    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : null;
    if (!redirectUris || !redirectUris.length || redirectUris.length > 10) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array of at most 10 URIs.',
      });
    }
    for (const uri of redirectUris) {
      if (!mcpOauth.isAllowedRedirectUri(uri, config)) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'Redirect URI host is not permitted by this deployment.',
        });
      }
    }
    const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
    const clientName = (rawName || 'MCP client').slice(0, 128);

    try {
      const client = await mcpOauth.registerClient(pool, { clientName, redirectUris });
      return res.status(201).json({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        // Public client: no secret is issued, and PKCE is what binds the
        // code to the requester.
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      });
    } catch (err) {
      log.error('mcp-remote', 'client registration failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // ── Consent page shell ───────────────────────────────────────────────
  //
  // Publicly reachable so the chat product can redirect to it, but it
  // serves ONLY the shell: request details need a platform session and come
  // from the session-authenticated route in the browser router below.
  router.get(CONSENT_PATH, (_req, res) => {
    res.setHeader('Content-Security-Policy', CONSENT_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.sendFile(path.join(__dirname, '../../public/connect-authorize.html'));
  });

  // ── Token endpoint ───────────────────────────────────────────────────
  //
  // Accepts form encoding (what OAuth clients send) as well as JSON.
  router.post(
    '/api/connect/oauth/token',
    express.urlencoded({ extended: false, limit: '4kb' }),
    jsonBody('4kb'),
    async (req, res) => {
      const ok = await enforceBucket(pool, res, {
        namespace: 'mcp-token-ip',
        subject: clientIp(req),
        ratePerMinute: IP_RATE_PER_MINUTE,
        capacity: IP_RATE_PER_MINUTE,
      });
      if (!ok) return undefined;

      const body = req.body || {};
      const grantType = body.grant_type;
      const clientId = body.client_id;

      const client = await mcpOauth.loadClient(pool, clientId).catch(() => null);
      if (!client) return res.status(400).json({ error: 'invalid_client' });

      if (grantType === 'authorization_code') {
        const code = body.code;
        const redirectUri = body.redirect_uri;
        const verifier = body.code_verifier;
        if (typeof code !== 'string' || typeof redirectUri !== 'string') {
          return res.status(400).json({ error: 'invalid_request' });
        }
        try {
          const outcome = await mcpOauth.withTransaction(pool, async (dbClient) => {
            const consumed = await mcpOauth.consumeAuthorizationCode(dbClient, {
              code, clientId, redirectUri,
            });
            if (consumed.error) {
              // A replayed code means the code leaked: kill everything
              // minted from that consent rather than only refusing here.
              if (consumed.replay && consumed.row) {
                await mcpOauth.revokeGrant(dbClient, consumed.row.grant_id);
              }
              return { error: consumed.error };
            }
            const row = consumed.row;
            if (!mcpOauth.verifyPkce(verifier, row.code_challenge)) {
              return { error: 'invalid_grant' };
            }
            const issued = await mcpOauth.issueTokenPair(dbClient, {
              userId: row.user_id,
              clientId,
              grantId: row.grant_id,
              scopes: row.scopes,
            });
            await mcpOauth.insertAudit(dbClient, {
              eventType: 'token_issued',
              occurredAt: new Date(),
              userId: row.user_id,
              actorUserId: row.user_id,
              accessTokenId: issued.accessTokenId,
              clientId,
              scopes: row.scopes,
              metadata: { grant: 'authorization_code' },
            });
            return { issued, scopes: row.scopes };
          });
          if (outcome.error) return res.status(400).json({ error: outcome.error });
          return res.json({
            access_token: outcome.issued.accessToken,
            token_type: 'Bearer',
            expires_in: outcome.issued.expiresIn,
            refresh_token: outcome.issued.refreshToken,
            scope: outcome.scopes.join(' '),
          });
        } catch (err) {
          log.error('mcp-remote', 'code exchange failed', { message: err.message });
          return res.status(503).json({ error: 'temporarily_unavailable' });
        }
      }

      if (grantType === 'refresh_token') {
        const refreshToken = body.refresh_token;
        if (!mcpOauth.isCanonicalSecret(refreshToken, REFRESH_PREFIX)) {
          return res.status(400).json({ error: 'invalid_grant' });
        }
        try {
          const outcome = await mcpOauth.rotateRefreshToken(pool, { refreshToken, clientId });
          if (outcome.error) return res.status(400).json({ error: outcome.error });
          return res.json({
            access_token: outcome.issued.accessToken,
            token_type: 'Bearer',
            expires_in: outcome.issued.expiresIn,
            refresh_token: outcome.issued.refreshToken,
            scope: outcome.scopes.join(' '),
          });
        } catch (err) {
          log.error('mcp-remote', 'refresh failed', { message: err.message });
          return res.status(503).json({ error: 'temporarily_unavailable' });
        }
      }

      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
  );

  // ── RFC 7009: revocation ─────────────────────────────────────────────
  // Revokes the whole grant chain: a client asking to forget one credential
  // means the connection is over, and leaving the sibling alive would be a
  // surprise.
  router.post(
    '/api/connect/oauth/revoke',
    express.urlencoded({ extended: false, limit: '4kb' }),
    jsonBody('4kb'),
    async (req, res) => {
      const ok = await enforceBucket(pool, res, {
        namespace: 'mcp-token-ip',
        subject: clientIp(req),
        ratePerMinute: IP_RATE_PER_MINUTE,
        capacity: IP_RATE_PER_MINUTE,
      });
      if (!ok) return undefined;
      const token = (req.body && req.body.token) || '';
      const isAccess = mcpOauth.isCanonicalSecret(token, TOKEN_PREFIX);
      const isRefresh = mcpOauth.isCanonicalSecret(token, REFRESH_PREFIX);
      // RFC 7009: an unknown or malformed token is still a 200 — the client
      // asked for it to be gone and it is gone.
      if (!isAccess && !isRefresh) return res.status(200).end();
      try {
        await mcpOauth.withTransaction(pool, async (dbClient) => {
          const { rows } = await dbClient.query(
            'SELECT grant_id, user_id, client_id, scopes FROM mcp_tokens WHERE token_hash = $1',
            [mcpOauth.hashSecret(token)]
          );
          if (!rows.length) return;
          await mcpOauth.revokeGrant(dbClient, rows[0].grant_id);
          await mcpOauth.insertAudit(dbClient, {
            eventType: 'token_revoked',
            occurredAt: new Date(),
            userId: rows[0].user_id,
            actorUserId: rows[0].user_id,
            clientId: rows[0].client_id,
            scopes: rows[0].scopes,
            metadata: { reason: 'client_revocation' },
          });
        });
      } catch (err) {
        log.error('mcp-remote', 'revocation failed', { message: err.message });
      }
      return res.status(200).end();
    }
  );

  // ── The MCP endpoint ─────────────────────────────────────────────────
  //
  // Stateless Streamable HTTP: a fresh McpServer + transport per request,
  // closed with the response. One platform process, restart-safe, and no
  // server-initiated notifications are needed because every long operation
  // in this design is poll-based.
  router.post(MCP_PATH, jsonBody('512kb'), async (req, res) => {
    const ipOk = await enforceBucket(pool, res, {
      namespace: 'mcp-ip',
      subject: clientIp(req),
      ratePerMinute: IP_RATE_PER_MINUTE,
      capacity: IP_RATE_PER_MINUTE,
    });
    if (!ipOk) return undefined;

    const bearer = readConnectorBearer(req);
    if (bearer.error) return bearerChallenge(config, res, bearer.error);

    let auth;
    try {
      auth = await authenticateConnector(pool, bearer.token);
    } catch (err) {
      log.error('mcp-remote', 'token lookup failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
    if (auth.error) return bearerChallenge(config, res, auth.error);
    // Defence in depth behind the gate: where the consent surface is off, only
    // a delegated grant may be served, whatever shape let the request in.
    if (connectorSurfaceClosed(config) && !auth.delegation) {
      return res.status(404).json({ error: 'not_found' });
    }

    const tokenOk = await enforceBucket(pool, res, {
      namespace: 'mcp-token',
      subject: String(auth.tokenId),
      ratePerMinute: TOKEN_RATE_PER_MINUTE,
      capacity: TOKEN_RATE_PER_MINUTE,
    });
    if (!tokenOk) return undefined;

    // The authorization decision is durably recorded BEFORE anything is
    // dispatched. An audit we cannot write is an authorization we do not
    // grant.
    try {
      await mcpOauth.withTransaction(pool, async (dbClient) => {
        await mcpOauth.insertAudit(dbClient, {
          eventType: 'token_used',
          occurredAt: auth.now,
          userId: auth.user.id,
          actorUserId: auth.user.id,
          accessTokenId: auth.tokenId,
          clientId: auth.clientId,
          scopes: auth.scopes,
          outcome: 'scope_authorized',
          metadata: { method: 'POST', route: MCP_PATH },
        });
      });
    } catch (err) {
      log.error('mcp-remote', 'audit insert failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }

    pool.query(
      `UPDATE mcp_tokens
          SET last_used_at = GREATEST(COALESCE(last_used_at, created_at), clock_timestamp())
        WHERE id = $1`,
      [auth.tokenId]
    ).catch((err) => {
      log.warn('mcp-remote', 'last_used_at update failed', { message: err.message });
    });

    // ── Arm the setup hint ───────────────────────────────────────────────
    //
    // `initialize` is the one message in this protocol that means "a session
    // is starting" — everything else the transport carries happens inside one
    // that already began. This endpoint is stateless, so that message is the
    // only signal available for "a new conversation", and services/
    // mcp-hint-throttle.js keys the whole throttle on it.
    //
    // Read off `req.body` because jsonBody() has already parsed it and
    // handleRequest() takes it as a parameter below — so this observes the
    // same object the SDK is about to dispatch, without consuming the stream.
    // A JSON-RPC batch arrives as an array; one arm per request either way.
    //
    // Placed AFTER authentication and the audit insert, and never before: it
    // writes a row keyed on a grant, and an unauthenticated caller must not be
    // able to write one. Fire-and-forget for the same reason as last_used_at
    // above — an advisory tip must not delay or fail a working request.
    // A delegated grant is the platform's own agent, with no human reading
    // its permission prompts, so it never arms the tip.
    if (isInitializeRequest(req.body) && !auth.delegation
        && !mcpTools.hintSuppressedForClient(auth.clientName)) {
      require('../services/mcp-hint-throttle')
        .armHint(pool, { grantId: auth.grantId, userId: auth.user.id })
        .catch((err) => {
          log.warn('mcp-remote', 'hint arm failed', { message: err.message });
        });
    }

    let transport;
    try {
      const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
      const {
        StreamableHTTPServerTransport,
      } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

      // #2779: the instructions, like the tool list, follow the token's
      // kind — a delegated agent is told what it is, not how a human-driven
      // chat product relays a work order.
      const kind = auth.delegation ? auth.delegation.kind : 'external';
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        // Count collections before Zod validation can allocate for them.
        { instructions: mcpTools.instructionsFor(kind), maxToolInputElements: 10_000 }
      );
      mcpTools.registerTools(server, {
        accessToken: bearer.token,
        scopes: auth.scopes,
        user: auth.user,
        clientName: auth.clientName,
        clientId: auth.clientId,
        delegation: auth.delegation,
        // Both only for the setup-hint throttle in registerTools. The grant
        // is the durable stand-in for "this connection" — this transport is
        // stateless (sessionIdGenerator is undefined, a fresh McpServer per
        // request), so there is no session identity to key on. The token is
        // recorded as a diagnostic and nothing more: keying the throttle on
        // it is the bug the arm-on-initialize above replaced.
        tokenId: auth.tokenId,
        grantId: auth.grantId,
        // Unset where the consent surface is off (staging); links then stay
        // relative, which is right for an agent running inside the platform.
        origin: config.cliAuthOrigin || '',
        baseUrl: platformBaseUrl(config),
        pool,
        config,
      });

      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('mcp-remote', 'MCP dispatch failed', { message: err.message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
    return undefined;
  });

  // Stateless mode has no server-to-client stream and no session to delete.
  router.all(MCP_PATH, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is POST-only.' },
      id: null,
    });
  });

  return router;
}

// ── Router 2: browser-session surfaces ─────────────────────────────────

function mcpBrowserRoutes(config) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const pool = getPool(config);

  router.use([
    '/api/connect/authorization',
    '/api/connect/oauth/authorize',
    '/api/me/connectors',
    '/api/me/connectors/*',
  ], noStore);

  const userRate = async (req, res, next) => {
    const ok = await enforceBucket(pool, res, {
      namespace: 'mcp-user',
      subject: String((req.user && req.user.id) || clientIp(req)),
      ratePerMinute: 60,
      capacity: 60,
    });
    if (ok) next();
  };

  // ── Consent: request details ─────────────────────────────────────────
  //
  // The consent page asks for this after the user is signed in. It echoes
  // back only what the page must display: the registered client name, the
  // REDIRECT ORIGIN (the load-bearing fact — a name is attacker-chosen, an
  // origin is not) and the scopes in plain language.
  router.get('/api/connect/authorization', userRate, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    const clientId = req.query.client_id;
    const redirectUri = req.query.redirect_uri;
    const client = await mcpOauth.loadClient(pool, clientId).catch(() => null);
    if (!client) return res.status(404).json({ error: 'invalid_or_unknown_client' });
    if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri)) {
      return res.status(404).json({ error: 'invalid_or_unknown_client' });
    }
    const scopes = mcpOauth.normalizeScopes(req.query.scope);
    if (!scopes) return res.status(400).json({ error: 'invalid_scope' });
    let origin = '';
    try { origin = new URL(redirectUri).origin; } catch { origin = ''; }
    return res.json({
      client_name: client.client_name,
      redirect_origin: origin,
      username: req.user.username,
      scopes: scopes.map((scope) => ({
        id: scope,
        label: scope === READ_SCOPE ? 'See your apps' : 'Propose changes',
        detail: scope === READ_SCOPE
          ? 'The apps you can already build on, their open requests, and your proposals.'
          : 'File requests, prepare work for a coding agent, and turn finished work into a proposal for the group vote.',
      })),
    });
  });

  // ── Consent: the decision ────────────────────────────────────────────
  //
  // Session-authenticated and CSRF-checked; the authorization is bound to
  // req.user.id, never to anything the request carries.
  router.post('/api/connect/oauth/authorize', userRate, jsonBody('4kb'), async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (!browserCsrf(config, req, res)) return undefined;

    const body = req.body || {};
    const client = await mcpOauth.loadClient(pool, body.client_id).catch(() => null);
    if (!client) return res.status(404).json({ error: 'invalid_or_unknown_client' });
    const redirectUri = body.redirect_uri;
    if (typeof redirectUri !== 'string' || !client.redirect_uris.includes(redirectUri)) {
      return res.status(404).json({ error: 'invalid_or_unknown_client' });
    }
    const scopes = mcpOauth.normalizeScopes(body.scope);
    if (!scopes) return res.status(400).json({ error: 'invalid_scope' });
    const challenge = body.code_challenge;
    if (body.code_challenge_method !== 'S256'
        || typeof challenge !== 'string'
        || !mcpOauth.CODE_CHALLENGE_RE.test(challenge)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const state = typeof body.state === 'string' ? body.state.slice(0, 512) : '';

    if (body.decision !== 'approve') {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (state) url.searchParams.set('state', state);
      return res.json({ redirect_to: url.toString() });
    }

    try {
      const { code } = await mcpOauth.issueAuthorizationCode(pool, {
        clientId: client.client_id,
        userId: req.user.id,
        scopes,
        redirectUri,
        codeChallenge: challenge,
      });
      await mcpOauth.withTransaction(pool, async (dbClient) => {
        await mcpOauth.insertAudit(dbClient, {
          eventType: 'authorization_approved',
          occurredAt: new Date(),
          userId: req.user.id,
          actorUserId: req.user.id,
          clientId: client.client_id,
          scopes,
          metadata: { client_name: client.client_name },
        });
      });
      const url = new URL(redirectUri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      log.info('mcp-remote', 'Connector authorized', {
        userId: req.user.id, clientId: client.client_id,
      });
      return res.json({ redirect_to: url.toString() });
    } catch (err) {
      log.error('mcp-remote', 'authorization failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // ── Settings: connected chat products ────────────────────────────────
  router.get('/api/me/connectors', userRate, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });

    // Staging mock data: mcp_tokens is staging:private (schema.sql), so a
    // staging clone always has an empty list and the Settings section would
    // review as a blank panel. ?demo=1 fabricates two rows without touching
    // the DB — same pattern as GET /api/me/cli-tokens, and a strict no-op
    // in production.
    if (process.env.USERNODE_ENV === 'staging') {
      const fixture = demoConnectorState(req.query.demo);
      return res.json(
        fixture
          ? { ...fixture, demo: true }
          // No credential can exist on staging (the surface that mints one
          // is 404 there), so the honest answer without the flag is "none".
          : { connectors: [], hint: demoHintStatus({}) }
      );
    }

    try {
      // One row per GRANT (a consent), not per token: rotation mints a new
      // pair on every refresh, and a user does not think in tokens.
      //
      // Delegated grants (#2779) are left out: they are the platform's own
      // agents for the length of one turn, not a chat product the user
      // connected, and listing one would offer a Disconnect for something
      // the user never connected and that is gone before they could press it.
      const { rows } = await pool.query(
        `SELECT t.grant_id,
                MIN(t.created_at)  AS connected_at,
                MAX(t.last_used_at) AS last_used_at,
                MAX(c.client_name)  AS client_name,
                BOOL_OR(t.revoked_at IS NULL
                        AND t.expires_at > clock_timestamp()) AS active
           FROM mcp_tokens t
           LEFT JOIN mcp_clients c ON c.client_id = t.client_id
          WHERE t.user_id = $1
            AND NOT EXISTS (SELECT 1 FROM mcp_delegations d WHERE d.grant_id = t.grant_id)
          GROUP BY t.grant_id
          ORDER BY MIN(t.created_at) DESC
          LIMIT 50`,
        [req.user.id]
      );
      // The setup-tip status, read-only. It rides on this response rather than
      // on an endpoint of its own because it is one line of the same panel and
      // is worthless without the list next to it. READ-ONLY is the load-bearing
      // word: there is deliberately no control here that writes throttle state,
      // because a "show it again" button is a button for making the connector
      // nag. Opening a new chat arms it — see services/mcp-hint-throttle.js.
      //
      // Cookie-authenticated only, like everything else in this router: a
      // connector bearer token cannot reach /api/me/connectors at all (the
      // connector allowlist in services/cli-api-policy.js does not carry it),
      // so the tip's own throttle state is not readable by the thing being
      // throttled.
      const hint = await require('../services/mcp-hint-throttle')
        .getHintStatus(pool, { userId: req.user.id });

      return res.json({
        connectors: rows
          .filter((row) => row.active)
          .map((row) => ({
            id: row.grant_id,
            client_name: row.client_name || 'Unknown client',
            connected_at: new Date(row.connected_at).toISOString(),
            last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
            status: 'connected',
          })),
        hint,
      });
    } catch (err) {
      log.error('mcp-remote', 'connector list failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  // Disconnect: revokes every token minted from that one consent, in one
  // transaction, and audits it. Takes effect immediately.
  router.delete('/api/me/connectors/:id', userRate, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (!browserCsrf(config, req, res)) return undefined;
    const grantId = req.params.id;
    if (!mcpOauth.GRANT_ID_RE.test(grantId || '')) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    try {
      const found = await mcpOauth.withTransaction(pool, async (dbClient) => {
        // A delegated grant is not the user's to disconnect here: it is not
        // listed, and its own turn revokes it (#2779).
        const { rows } = await dbClient.query(
          `SELECT t.grant_id, t.client_id, t.scopes FROM mcp_tokens t
            WHERE t.grant_id = $1 AND t.user_id = $2
              AND NOT EXISTS (SELECT 1 FROM mcp_delegations d WHERE d.grant_id = t.grant_id)
            LIMIT 1`,
          [grantId, req.user.id]
        );
        if (!rows.length) return false;
        await mcpOauth.revokeGrant(dbClient, grantId);
        await mcpOauth.insertAudit(dbClient, {
          eventType: 'token_revoked',
          occurredAt: new Date(),
          userId: req.user.id,
          actorUserId: req.user.id,
          clientId: rows[0].client_id,
          scopes: rows[0].scopes,
          metadata: { reason: 'settings' },
        });
        return true;
      });
      return found ? res.status(204).end() : res.status(404).json({ error: 'not_found' });
    } catch (err) {
      log.error('mcp-remote', 'disconnect failed', { message: err.message });
      return res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  return router;
}

// Staging mock data for the Settings → connectors list. Obviously fake,
// written nowhere, and only ever returned in staging with a ?demo= flag.
//
// mcp_tokens AND mcp_connector_hints are both staging:private, so without
// these a staging clone renders an empty list and a status line with nothing
// to say — which is exactly the part of the panel a reviewer needs to see.
function demoConnector(kind, overrides = {}) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = {
    claude: {
      id: 'staging-demo-connector-1',
      client_name: 'Claude (claude.ai)',
      connected_at: iso(now - 6 * day),
      last_used_at: iso(now - 20 * 60 * 1000),
    },
    chatgpt: {
      id: 'staging-demo-connector-2',
      client_name: 'ChatGPT (chatgpt.com)',
      connected_at: iso(now - 2 * day),
      last_used_at: null,
    },
    // A client whose name matches neither family. The panel must fall back to
    // showing every case rather than guessing — this is the fixture that makes
    // that fallback reviewable.
    unknown: {
      id: 'staging-demo-connector-3',
      client_name: 'Some other MCP client',
      connected_at: iso(now - 9 * day),
      last_used_at: iso(now - 3 * day),
    },
  }[kind];
  return { ...base, status: 'connected', demo: true, ...overrides };
}

function demoConnectors() {
  return [demoConnector('claude'), demoConnector('chatgpt')];
}

function demoHintStatus({ shownThisWindow = 0, lastShownMinutesAgo = null } = {}) {
  const throttle = require('../services/mcp-hint-throttle');
  return {
    shownThisWindow,
    lastShownAt: lastShownMinutesAgo == null
      ? null
      : new Date(Date.now() - lastShownMinutesAgo * 60 * 1000).toISOString(),
    maxPerWindow: throttle.MAX_SHOWS_PER_WINDOW,
    windowDays: throttle.HINT_WINDOW_DAYS,
    cooldownMinutes: throttle.HINT_COOLDOWN_MINUTES,
  };
}

// Every reviewable state of the panel, one ?demo= value each. `1` stays the
// everyday mixed one so the existing declared tests keep pointing at it.
//
// The panel now says different things depending on WHICH families are
// connected and where the tip's weekly budget stands, and none of that is
// reachable from a staging clone: mcp_tokens and mcp_connector_hints are both
// staging:private, so the real tables are empty there. A state with no fixture
// is a state no reviewer can look at.
function demoConnectorState(flag) {
  switch (flag) {
    case '1':
      return {
        connectors: demoConnectors(),
        hint: demoHintStatus({ shownThisWindow: 1, lastShownMinutesAgo: 95 }),
      };
    // Claude only, tip never shown: the state a fresh connection is in, and
    // the one where the Claude Code cases are the only ones that apply.
    case 'connectors-claude':
      return { connectors: [demoConnector('claude')], hint: demoHintStatus({}) };
    // Claude only, shown recently — the "why haven't I seen anything" question
    // answered with a date instead of a guess.
    case 'connectors-claude-shown':
      return {
        connectors: [demoConnector('claude')],
        hint: demoHintStatus({ shownThisWindow: 1, lastShownMinutesAgo: 95 }),
      };
    // ChatGPT only. The tip is SUPPRESSED for this family — there are no
    // per-call permission prompts there to stop — so the status is absent
    // rather than zeroed: a "not shown yet" line would read as a promise that
    // one is coming. The panel must render no line at all here.
    case 'connectors-chatgpt':
      return { connectors: [demoConnector('chatgpt')] };
    // A client name that matches neither family. The panel falls back to
    // showing every case rather than guessing.
    case 'connectors-unknown':
      return { connectors: [demoConnector('unknown')], hint: demoHintStatus({}) };
    // Shown minutes ago, inside the cooldown. The distinct state the panel
    // has to be able to say something about: budget left, but nothing coming
    // until the hour is up. Without a fixture the only way to see this line
    // is to catch a real connection in a sixty-minute window.
    case 'connectors-cooldown':
      return {
        connectors: [demoConnector('claude')],
        hint: demoHintStatus({ shownThisWindow: 1, lastShownMinutesAgo: 12 }),
      };
    // This week's budget spent. The panel says so plainly, and says the window
    // rolls over, instead of offering a reset — there is deliberately nothing
    // here that writes throttle state.
    case 'connectors-spent':
      return {
        connectors: demoConnectors(),
        hint: demoHintStatus({ shownThisWindow: 3, lastShownMinutesAgo: 40 }),
      };
    default:
      return null;
  }
}

module.exports = {
  mcpConnectGate,
  mcpPreAuthRoutes,
  mcpBrowserRoutes,
  isConnectorSurface,
  readConnectorBearer,
  authenticateConnector,
  demoConnectors,
  demoConnectorState,
  isInitializeRequest,
};
