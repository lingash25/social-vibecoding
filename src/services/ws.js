const { nativeWebSessionIsLive } = require('./web-session-auth');
const http = require('http');
const { WebSocketServer } = require('ws');
const { getPool } = require('../db/pool');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const notifications = require('./notifications');
const events = require('./events');
const appAccess = require('./app-access');
const communities = require('./communities');
const attachmentsSvc = require('./attachments');
const appChat = require('./app-chat');
const wsBus = require('./ws-bus');

// #328: server-side cap on a single chat message body. Must match the
// composer `maxlength` (GC_MAX_MESSAGE_LEN in public/js/group-chat.js) — both
// ends agree so a message that passes the composer isn't silently truncated
// here on insert. Raised from 2000 to 8000 alongside markdown support. We
// trim then truncate (rather than reject) to mirror the long-standing
// behaviour: an over-length body from a hostile/buggy client is clamped, not
// dropped.
const MAX_CHAT_LEN = 8000;

let wss;
// Captured in attach() so the module-level push* helpers can run the
// per-app visibility filter (appAccess.getWsVisibility) without every
// caller having to thread a pool through.
let _pool = null;
const rooms = new Map(); // appId -> Set<{ ws, user }>
const globalClients = new Set(); // Set<{ ws, user }> for /ws/events

// A message from ANOTHER instance. Route it through the same local delivery
// the emitting pod already ran, so one code path decides who may see what.
//
// `oversize` means the payload did not fit in a NOTIFY (8000 bytes) and was
// not sent. The audience still needs to know something moved, so they get the
// nudge their own reconnect path already handles — `resyncCurrentView` in
// public/js/app.js — rather than a truncated event.
function _onBusMessage({ kind, routing, data, oversize }) {
  const r = routing || {};
  const payload = oversize ? { type: 'resync_hint' } : data;
  if (payload == null) return;
  switch (kind) {
    case 'global':
      deliverGlobal(payload);
      return;
    case 'room':
      if (r.appId != null) deliverToRoom(r.appId, payload, null, r);
      return;
    case 'scoped':
      // An oversize scoped event degrades to a GLOBAL nudge rather than a
      // scoped one: "re-pull what you are looking at" leaks nothing, and
      // running the visibility lookup to decide who may receive a content-free
      // hint would cost a query per instance to protect nothing.
      if (oversize) deliverGlobal(payload);
      else deliverGlobalScoped(payload, { appId: r.appId ?? null, appSlug: r.appSlug ?? null });
      return;
    case 'admins':
      deliverToAdmins(payload);
      return;
    case 'user':
      if (r.userId != null) deliverToUser(r.userId, payload);
      return;
    case 'account_deleted':
      void require('./account-deletion-runtime').receive(_pool, r.userId)
        .catch(() => log.warn('ws', 'Account stream cleanup will retry'));
      return;
    case 'agent_stop':
      if (!oversize) void require('./mayor/agent-turn').receiveStopRequest(_pool, payload)
        .catch(() => log.warn('ws', 'Agent stop notification will retry from durable state'));
      return;
    case 'homeroom_bot':
      // Not a socket event at all: the Homeroom bot's loop runs on one Pod
      // and an issue event can land on any, so the wake rides this bus.
      // The bot ignores it on every Pod but the one running the loop.
      require('./homeroom-bot').onBusMessage(payload);
      return;
    default:
      log.warn('ws', 'unknown bus kind', { kind });
  }
}

// The Homeroom bot follows issue activity. Best-effort by construction: the
// event has already been delivered, and a bot that fails to hear it is
// caught up by its reconcile sweep.
function noteIssueActivityForBot(appId, issueNumber, reason) {
  try {
    require('./homeroom-bot').noteIssueActivity({ appId, issueNumber, reason });
  } catch (err) {
    log.warn('ws', 'homeroom bot wake failed', { err: err.message });
  }
}

function noteProposalActivityForBot(pool, appId, sessionId) {
  try {
    Promise.resolve(require('./homeroom-bot').noteProposalActivity(pool, { appId, sessionId })).catch(() => {});
  } catch (err) {
    log.warn('ws', 'homeroom bot wake failed', { err: err.message });
  }
}

function disconnectUser(userId) {
  for (const clients of [globalClients, ...rooms.values()]) {
    for (const client of clients) {
      if (Number(client.user.id) !== Number(userId)) continue;
      clients.delete(client);
      client.ws.terminate();
    }
  }
}

function connectedUserIds() {
  return [...new Set([globalClients, ...rooms.values()]
    .flatMap(clients => [...clients].map(client => Number(client.user.id))))];
}

function attach(server, config) {
  const pool = getPool(config);
  // Also reconcile after a missed NOTIFY or reconnect. This includes HTTP
  // streams; the timer runs on every pod, independently of leader duties.
  const revocationTimer = setInterval(() => {
    void require('./account-deletion-runtime').reconcile(pool)
      .catch(() => log.warn('ws', 'Account revocation check unavailable'));
  }, 30_000);
  revocationTimer.unref();
  server.once('close', () => clearInterval(revocationTimer));
  _pool = pool;

  // Cross-instance fan-out. A single-pod deployment (the shipped default)
  // behaves exactly as before: every event is still delivered locally first,
  // and its own echo is dropped by instance id.
  wsBus.start({
    pool,
    connectionString: config.databaseUrl,
    onMessage: _onBusMessage,
  });

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    // Caddy's forward_auth PRESERVES the Connection/Upgrade headers on its
    // auth subrequest while rewriting the URI to /__caddy/access. Node
    // routes any upgrade-flagged request to this 'upgrade' event instead of
    // the normal request listener, so the gate pre-flight for every proxied
    // WebSocket lands here — where it used to fall through to
    // socket.destroy(). forward_auth then read EOF, answered 502, and every
    // WS behind the wildcard (all staging previews / child apps) was
    // unreachable: group chat sat on "Reconnecting…" forever. Re-dispatch
    // anything that isn't one of our real WS endpoints into the regular
    // handler chain (Express) so /__caddy/access — or any other route — can
    // answer with a proper HTTP response over this socket.
    if (!req.url?.startsWith('/ws/')) {
      const handler = server.listeners('request')[0];
      if (!handler) { socket.destroy(); return; }
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      res.shouldKeepAlive = false;
      res.on('finish', () => {
        try { socket.end(); } catch { /* already gone */ }
      });
      handler(req, res);
      return;
    }

    const user = await authenticateWs(req, pool, config);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.url?.startsWith('/ws/events')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user };
        globalClients.add(client);
        void pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id])
          .then(result => { if (!result.rows.length) disconnectUser(user.id); })
          .catch(() => disconnectUser(user.id));
        log.debug('ws', 'Global events client connected', { userId: user.id });
        // Which build this socket landed on — see sendPlatformVersion. A tab
        // whose socket comes back after a rollout learns the new build from
        // the handshake, not from its next poll.
        sendPlatformVersion(ws, 'connected');

        ws.on('close', () => {
          globalClients.delete(client);
          log.debug('ws', 'Global events client disconnected', { userId: user.id });
        });
      });
      return;
    }

    if (req.url?.startsWith('/ws/chat/')) {
      const appSlug = req.url.replace('/ws/chat/', '').split('?')[0];
      if (!appSlug) { socket.destroy(); return; }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { user, appSlug });
      });
      return;
    }

    socket.destroy();
  });

  wss.on('connection', async (ws, req, { user, appSlug }) => {
    const app = await resolveAppForAccess(pool, appSlug);
    if (!app) {
      ws.close(4004, 'App not found');
      return;
    }
    // Connect gate is view-level (#621): anyone who may see the app can
    // receive live chat/room broadcasts read-only. Same 4004 as "not
    // found" so the room's existence isn't disclosed (matches the
    // routes' 404-on-deny rule). Mutating message types re-check collab
    // access per message inside handleMessage.
    const allowed = await appAccess.checkAppAccess(pool, app, user, 'view')
      .catch(() => false);
    if (!allowed) {
      ws.close(4004, 'App not found');
      return;
    }
    const appId = app.id;

    const client = { ws, user, appId, appSlug };
    joinRoom(appId, client);
    const live = await pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id]).catch(() => ({ rows: [] }));
    if (!live.rows.length) { disconnectUser(user.id); return; }

    log.info('ws', 'Client connected', { userId: user.id, appSlug });

    ws.on('message', async (raw) => {
      try {
        const live = await pool.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL', [user.id]);
        if (!live.rows.length) { disconnectUser(user.id); return; }
        const msg = JSON.parse(raw);
        await handleMessage(pool, client, msg);
      } catch (err) {
        log.warn('ws', 'Invalid message', { err: err.message });
      }
    });

    ws.on('close', () => {
      leaveRoom(appId, client);
      log.debug('ws', 'Client disconnected', { userId: user.id, appSlug });
    });
  });

  log.info('ws', 'WebSocket server attached');
}

// Staging-only iframe-JWT fallback, mirroring src/middleware/auth.js.
// `sessions` is staging:private (truncated on every staging redeploy), so
// a browser that kept a cookie from the previous deploy fails the cookie
// path forever: HTTP recovers because the middleware re-mints a session
// from the shell-injected ?token= JWT, but a WebSocket handshake can't
// follow that flow — it just 401s and the client shows "Reconnecting…"
// until the page is reloaded. Accepting the same JWT here (sent by the
// client as ?token= on the WS URL) closes that gap. Gated on
// USERNODE_ENV === 'staging' exactly like the middleware, so prod WS auth
// remains cookie-only.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

async function authenticateWs(req, pool, config) {
  const viaCookie = await authenticateWsCookie(req, pool);
  if (viaCookie) return viaCookie;
  if (!IS_STAGING) return null;
  return authenticateWsStagingJwt(req, pool, config);
}

async function authenticateWsCookie(req, pool) {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session;
    if (!token) return null;

    const { rows } = await pool.query(
      `SELECT s.user_id, s.expires_at, u.username, u.is_admin
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND ${nativeWebSessionIsLive('s')}`,
      [token]
    );

    if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
      return null;
    }

    return { id: rows[0].user_id, username: rows[0].username, isAdmin: rows[0].is_admin };
  } catch {
    return null;
  }
}

async function authenticateWsStagingJwt(req, pool, config) {
  try {
    let token;
    try {
      token = new URL(req.url || '', 'http://x').searchParams.get('token');
    } catch {
      return null;
    }
    if (!token) return null;

    // App-scoped identity token (RS256, audience `usernode:app:<id>`).
    // USERNODE_APP_ID is injected by services/app-identity-env.js; when
    // it's absent this fails closed, same as middleware/auth.js.
    let payload;
    try {
      payload = platformJwt.verifyAppIdentityToken(token, {
        appId: process.env.USERNODE_APP_ID,
      });
    } catch (err) {
      log.warn('ws', 'Staging iframe-JWT verification failed', { err: err.message });
      return null;
    }
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'number') return null;

    // Same defense-in-depth as tryMintSessionFromIframeJwt: resolve the
    // user from the local (cloned) users table and refuse on a username
    // mismatch (token minted before a rename).
    const { rows } = await pool.query(
      'SELECT id, username, is_admin FROM users WHERE id = $1',
      [payload.id]
    );
    if (rows.length === 0) return null;
    if (typeof payload.username === 'string' && payload.username !== rows[0].username) {
      return null;
    }

    return { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = {};
  header.split(';').forEach((pair) => {
    const [key, ...vals] = pair.trim().split('=');
    if (key) result[key.trim()] = vals.join('=').trim();
  });
  return result;
}

async function resolveAppForAccess(pool, slug) {
  const { rows } = await pool.query(
    'SELECT id, collab_visibility, view_visibility, moderation_suspended_at FROM apps WHERE slug = $1',
    [slug]
  );
  return rows[0] || null;
}

function joinRoom(appId, client) {
  if (!rooms.has(appId)) rooms.set(appId, new Set());
  rooms.get(appId).add(client);
}

function leaveRoom(appId, client) {
  const room = rooms.get(appId);
  if (room) {
    room.delete(client);
    if (room.size === 0) rooms.delete(appId);
  }
}

// LOCAL delivery. Every `deliver*` below sends to this process's sockets and
// nothing else; the `broadcast*` wrappers do that AND fan out to the other
// instances. Splitting them is what lets a bus message replay the identical
// local half on a remote pod without re-publishing it into a loop.
function deliverToRoom(appId, data, excludeWs = null, audience = {}) {
  const room = rooms.get(appId);
  if (!room) return;
  if (data.type === 'app_suspended') {
    for (const client of room) client.ws.close(4004, 'App suspended by moderation');
    return;
  }
  const payload = JSON.stringify(data);
  const hidden = new Set(audience.blockedUserIds || []);
  const quoteHidden = new Set(audience.quoteHiddenUserIds || []);
  const withoutQuote = quoteHidden.size && data.metadata?.quote
    ? JSON.stringify({ ...data, metadata: { ...data.metadata, quote: null } }) : null;
  const reactionVariants = audience.reactionsByViewer || {};
  // #2387: a reply thread's summary as seen by a viewer who blocked one of
  // its repliers (count and faces without that person). `null` is a real
  // variant — nothing left for them to see — so test for the key.
  const threadVariants = audience.threadByViewer || {};
  for (const client of room) {
    if (client.ws !== excludeWs && client.ws.readyState === 1 && !hidden.has(client.user.id)) {
      const reactions = reactionVariants[client.user.id];
      if (Object.prototype.hasOwnProperty.call(threadVariants, client.user.id)) {
        client.ws.send(JSON.stringify({ ...data, thread: threadVariants[client.user.id] }));
        continue;
      }
      client.ws.send(reactions
        ? JSON.stringify({ ...data, reactions })
        : (withoutQuote && quoteHidden.has(client.user.id) ? withoutQuote : payload));
    }
  }
}

// `excludeWs` is deliberately NOT published: it identifies a socket object in
// THIS process, and the sender it excludes cannot be connected to another one.
function broadcast(appId, data, excludeWs = null) {
  deliverToRoom(appId, data, excludeWs);
  wsBus.publish('room', { appId }, data);
}

// App discussions share a room across users, so a blocked sender must be
// removed from the local audience and from every remote pod's audience.
async function broadcastFromSender(pool, appId, data, senderId, excludeWs = null) {
  const { rows } = await pool.query(
    `SELECT blocker_id FROM user_blocks WHERE blocked_user_id = $1`, [senderId]
  );
  const routing = { appId, blockedUserIds: rows.map((row) => row.blocker_id) };
  const quotedId = Number(data.metadata?.quote?.refMsgId);
  if (Number.isInteger(quotedId) && quotedId > 0) {
    const quoted = await pool.query(
      `SELECT blocked.blocker_id FROM chat_messages quoted
         JOIN user_blocks blocked ON blocked.blocked_user_id = quoted.user_id
        WHERE quoted.id = $1`, [quotedId]
    );
    routing.quoteHiddenUserIds = quoted.rows.map((row) => row.blocker_id);
  }
  // #2387 follow-up: a reply-thread reply now draws a line in the general
  // stream naming its thread's first message. Whoever blocked that message's
  // author cannot open the thread and does not load its replies, so the live
  // frame is withheld from them too.
  const rootId = data.type === 'chat' && data.thread && data.thread.type === appChat.MESSAGE_THREAD
    ? Number(data.thread.ref) : null;
  if (rootId) {
    const rootBlockers = await pool.query(
      `SELECT blocked.blocker_id FROM chat_messages root
         JOIN user_blocks blocked ON blocked.blocked_user_id = root.user_id
        WHERE root.id = $1`, [rootId]
    );
    routing.blockedUserIds.push(...rootBlockers.rows.map((row) => row.blocker_id));
  }
  if (data.type === 'reaction') {
    const blockedReactors = await pool.query(
      `SELECT blocked.blocker_id, reactor.username
         FROM message_reactions reaction
         JOIN users reactor ON reactor.id = reaction.user_id
         JOIN user_blocks blocked ON blocked.blocked_user_id = reaction.user_id
        WHERE reaction.message_id = $1`, [data.messageId]
    );
    const namesByViewer = new Map();
    for (const row of blockedReactors.rows) {
      if (!namesByViewer.has(row.blocker_id)) namesByViewer.set(row.blocker_id, new Set());
      namesByViewer.get(row.blocker_id).add(row.username);
    }
    if (namesByViewer.size) {
      routing.reactionsByViewer = {};
      for (const [viewerId, names] of namesByViewer) {
        routing.reactionsByViewer[viewerId] = data.reactions.map((reaction) => {
          const users = reaction.users.filter((username) => !names.has(username));
          return { ...reaction, count: users.length, users };
        }).filter((reaction) => reaction.count > 0);
      }
    }
  }
  deliverToRoom(appId, data, excludeWs, routing);
  wsBus.publish('room', routing, data);
}

// #2387: tell the room a reply thread changed — a reply arrived, or one was
// deleted — so every general-stream row showing that root can redraw its
// "N replies" line without refetching. Sent after the change itself, and
// best-effort: a missed summary is corrected by the next history load.
async function broadcastThreadSummary(pool, appId, rootId, senderId) {
  try {
    const { thread, byViewer, withheldFrom = [] } = await appChat.threadSummaryForRoom(pool, appId, rootId);
    const { rows } = await pool.query(
      `SELECT blocker_id FROM user_blocks WHERE blocked_user_id = $1`, [senderId]
    );
    const routing = {
      appId,
      // The sender's blockers, and the blockers of a replier past the
      // per-viewer cap: the base frame would name the person they blocked.
      blockedUserIds: [...rows.map((row) => row.blocker_id), ...withheldFrom],
      threadByViewer: byViewer,
    };
    const data = { type: 'thread_summary', root_id: Number(rootId), thread };
    deliverToRoom(appId, data, null, routing);
    wsBus.publish('room', routing, data);
  } catch (err) {
    log.warn('ws', 'thread summary broadcast failed', { appId, rootId, err: err.message });
  }
}

// Broadcast to all connected clients (global events like app status changes)
function deliverGlobal(data) {
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const client of globalClients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
      sent++;
    }
  }
  if (data.event === 'cc_progress' && sent === 0 && globalClients.size === 0) {
    log.debug('ws', 'broadcastGlobal: no clients connected');
  }
  return sent;
}

function broadcastGlobal(data) {
  deliverGlobal(data);
  wsBus.publish('global', null, data);
}

// ── The build this process is, told over the socket (#2545) ───────────
//
// `platform_version` carries the one fact /api/version exists for — which
// build is being served — at the moment it is true rather than on the next
// poll. `sha` is a build a request from that tab will now land on: this
// process's own, sent on every /ws/events handshake (`reason: 'connected'`),
// or its successor's, pushed by the process being replaced once its listener
// has closed (`reason: 'rollout'`, see announceSuccessorBuild in server.js).
// The client treats both the same way: public/js/app.js handlePlatformVersion.
//
// Local sockets only, deliberately — no bus. The pod being replaced is telling
// the tabs IT holds that their traffic has moved; the new pod's own sockets
// learned its build from their handshake. Fanning out would reach only tabs
// whose answer is already in hand, and in a multi-replica rollout would tell
// a tab still served by an older pod about a build its requests may not reach
// yet.
function platformVersionPayload(sha, reason) {
  return { type: 'platform_version', sha: sha || 'dev', reason };
}

function sendPlatformVersion(socket, reason) {
  try {
    socket.send(JSON.stringify(platformVersionPayload(process.env.GIT_SHA, reason)));
  } catch { /* closed between the handshake and this send */ }
}

/** Returns the number of open events sockets told. */
function pushPlatformVersion({ sha, reason = 'rollout' } = {}) {
  if (!sha) return 0;
  return deliverGlobal(platformVersionPayload(sha, reason));
}

// #194: validate an inbound thread reference { type, ref } for an app.
// Returns { type, ref } when valid, null otherwise. 'session' and
// 'governance' refs must exist for THIS app (DB lookup); 'issue' refs
// accept any positive integer — the GitHub issue list is cached and
// eventual, so a strict existence check would reject messages on
// fresh issues for up to the cache TTL.
//
// #2387: 'message' is a reply thread, ref = its root. The root must be a
// general-stream message a person wrote in THIS app (so a reply can never
// be a root: no nesting), and — when `viewerId` is given — not by somebody
// the poster blocked, whose message they cannot see to answer.
const THREAD_TYPES = Object.freeze(['issue', 'session', 'governance', appChat.MESSAGE_THREAD]);

async function validateThread(pool, appId, thread, viewerId = null) {
  if (!thread || typeof thread !== 'object') return null;
  const type = thread.type;
  const ref = Number(thread.ref);
  if (!THREAD_TYPES.includes(type)) return null;
  if (!Number.isInteger(ref) || ref <= 0 || ref > 2147483647) return null;
  if (type === appChat.MESSAGE_THREAD) {
    const root = await appChat.findThreadRoot(pool, appId, ref, viewerId);
    if (!root) return null;
    // A deleted message starts no NEW thread (#2387), as in Messages; one
    // that already has replies stays open under its placeholder.
    if (root.deleted_at) {
      const { rows } = await pool.query(
        `SELECT 1 FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'message' AND thread_ref = $2 LIMIT 1`,
        [appId, ref]
      );
      if (!rows.length) return null;
    }
  } else if (type === 'session') {
    const { rows } = await pool.query(
      'SELECT 1 FROM chat_sessions WHERE id = $1 AND app_id = $2', [ref, appId]
    );
    if (!rows.length) return null;
  } else if (type === 'governance') {
    const { rows } = await pool.query(
      'SELECT 1 FROM issues WHERE id = $1 AND app_id = $2', [ref, appId]
    );
    if (!rows.length) return null;
  }
  return { type, ref };
}

// #621: mutating message types require collab access. Re-checked per
// message (not cached at connect) so a membership revocation takes
// effect immediately — chat rates are low and the lookup is a single
// indexed query. Dropped silently server-side (same pattern as the
// invalid-thread drop): read-only clients don't render these controls,
// so anything arriving here is a stale or hostile client.
const WRITE_MSG_TYPES = new Set(['chat', 'edit', 'react', 'typing']);

async function canWriteChat(pool, client) {
  if (await require('./moderation').isRestricted(pool, client.user.id)) return false;
  const { rows } = await pool.query(
    'SELECT id, collab_visibility, view_visibility, moderation_suspended_at FROM apps WHERE id = $1',
    [client.appId]
  );
  if (!rows.length) return false;
  return appAccess.checkAppAccess(pool, rows[0], client.user, 'collab');
}

async function handleMessage(pool, client, msg) {
  if (WRITE_MSG_TYPES.has(msg.type)) {
    let allowed;
    try {
      allowed = await canWriteChat(pool, client);
    } catch (err) {
      log.warn('ws', 'write message dropped: access check failed', {
        appId: client.appId, userId: client.user.id, type: msg.type, err: err.message,
      });
      return { ok: false, code: 'write_access_failed' };
    }
    if (!allowed) {
      log.warn('ws', 'write message dropped: not a collaborator', {
        appId: client.appId, userId: client.user.id, type: msg.type,
      });
      return { ok: false, code: 'not_collaborator' };
    }
  }
  // Posting in an app's chat is for the members of its community
  // (services/communities.js). Unlike the drops above, this one is ANSWERED:
  // the sender is a legitimate client whose composer does not know they have
  // not joined, so the refusal goes back to that one socket as a
  // `join_required` frame carrying the message, and the composer
  // (public/js/group-chat.js) offers Join and sends it again. Only 'chat':
  // see chatNeedsJoin for why typing and reactions are not gated.
  if (msg.type === 'chat') {
    let join = null;
    try {
      join = await communities.chatNeedsJoin(pool, client.appId, client.user);
    } catch (err) {
      log.warn('ws', 'chat message dropped: membership check failed', {
        appId: client.appId, userId: client.user.id, err: err.message,
      });
      return { ok: false, code: 'write_access_failed' };
    }
    if (join) {
      try {
        if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type: 'join_required', ...join, retry: msg }));
      } catch { /* a closed socket has nobody to ask */ }
      return { ok: false, code: 'join_required' };
    }
  }
  // HOMEROOM'S OLD CHANNEL IS READ-ONLY. The platform's own project talks
  // in #general now (the Homeroom community's channel), and this discussion
  // is kept as history: its main stream and its reply threads take no new
  // post. A proposal's or a request's own thread is not the channel and
  // stays open. Answered, like the join refusal, so the composer can say so.
  if (msg.type === 'chat' && (!msg.thread || msg.thread.type === 'message')) {
    let archived = false;
    try {
      archived = await communities.channelArchived(pool, client.appId);
    } catch (err) {
      log.warn('ws', 'channel archive check failed', { appId: client.appId, err: err.message });
    }
    if (archived) {
      try {
        if (client.ws && client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({ type: 'error', code: 'channel_moved', message: communities.CHANNEL_MOVED }));
        }
      } catch { /* a closed socket has nobody to tell */ }
      return { ok: false, code: 'channel_moved' };
    }
  }
  switch (msg.type) {
    case 'chat': {
      // #694: optional file attachments, uploaded beforehand via
      // POST /api/apps/:slug/chat-attachments. Malformed ids (or more
      // than the per-message cap) drop the whole message — the sender's
      // client is buggy or hostile either way.
      const attIds = attachmentsSvc.sanitizeAttachmentIds(msg.attachmentIds);
      if (attIds === null) {
        log.warn('ws', 'chat message dropped: bad attachment ids', {
          appId: client.appId, userId: client.user.id,
        });
        return { ok: false, code: 'invalid_attachment_ids' };
      }
      // An attachments-only send is allowed (#694): content stays ''
      // (column is NOT NULL) and the client renders no body.
      const content = (msg.content || '').trim().substring(0, MAX_CHAT_LEN);
      if (!content && !attIds.length) return { ok: false, code: 'empty_message' };

      // #194: optional thread scoping. An invalid/spoofed ref drops the
      // whole message (never silently re-route a thread post into the
      // general stream — the sender's client is buggy or hostile either
      // way, and general chat is the louder surface).
      let thread = null;
      if (msg.thread) {
        thread = await validateThread(pool, client.appId, msg.thread, client.user.id);
        if (!thread) {
          log.warn('ws', 'chat message dropped: invalid thread ref', {
            appId: client.appId, userId: client.user.id,
          });
          return { ok: false, code: 'invalid_thread' };
        }
      }

      // #15: optional quote (Signal-style reply). The client only sends a
      // reference (refMsgId for a chat row, or sessionId for a PR); we
      // re-derive author + snippet server-side from the referenced row so
      // a client can't spoof who said what. If the reference doesn't
      // validate we drop the quote silently and send a plain message.
      // `replyRecipientId` is the author of the quoted thing — used to
      // fire a reply notification below (NULL for system rows / self).
      let quote = null;
      let replyRecipientId = null;
      try {
        const q = msg.quote;
        if (q && typeof q === 'object') {
          if (q.source === 'pr' && Number.isInteger(q.sessionId)) {
            const { rows: prRows } = await pool.query(
              `SELECT cs.id, cs.user_id, cs.pr_number, cs.pr_title, cs.pr_url, u.username
               FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
               WHERE cs.id = $1 AND cs.app_id = $2`,
              [q.sessionId, client.appId]
            );
            if (prRows.length) {
              const r = prRows[0];
              quote = {
                source: 'pr',
                sessionId: r.id,
                prNumber: r.pr_number,
                author: r.username || null,
                snippet: (r.pr_title || `PR #${r.pr_number || r.id}`).substring(0, 200),
                href: r.pr_url || null,
              };
              replyRecipientId = r.user_id || null;
            }
          } else if (['message', 'event', 'spec'].includes(q.source) && Number.isInteger(q.refMsgId)) {
            const { rows: refRows } = await pool.query(
              `SELECT m.id, m.user_id, m.content, m.msg_type, m.metadata, m.moderation_hidden_at, u.username
               FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
               WHERE m.id = $1 AND m.app_id = $2 AND m.deleted_at IS NULL`,
              [q.refMsgId, client.appId]
            );
            // #2387: a deleted message cannot be quoted — its text is gone,
            // so the send goes out as a plain message.
            if (refRows.length) {
              const r = refRows[0];
              let snippet;
              let author;
              if (r.msg_type === 'spec_share') {
                const sm = (r.metadata || {}).specShare || {};
                snippet = sm.title || `Spec v${sm.version || ''}`.trim();
                author = sm.sharedBy?.username || r.username || null;
              } else if (r.msg_type === 'system' || r.msg_type === 'vote' || r.msg_type === 'conflict') {
                snippet = r.content;
                author = null; // system event — no person to attribute / notify
              } else {
                snippet = r.content;
                // #694: an attachments-only message has empty content —
                // quote it as its first file instead of a blank snippet.
                const quotedAtts = (r.metadata || {}).attachments;
                if (!snippet && Array.isArray(quotedAtts) && quotedAtts.length) {
                  snippet = `\u{1F4CE} ${quotedAtts[0].filename || 'file'}`;
                }
                author = r.username || null;
              }
              const normalizedSource = r.msg_type === 'spec_share'
                ? 'spec'
                : (r.msg_type === 'message' ? 'message' : 'event');
              quote = {
                source: normalizedSource,
                refMsgId: r.id,
                author,
                // Collapse any newlines (multi-line messages) to single
                // spaces so the compact "Replying to…" chip and the small
                // quoted block above a reply stay single-line.
                snippet: (snippet || '').replace(/\s+/g, ' ').trim().substring(0, 200),
              };
              replyRecipientId = r.user_id || null;
            }
          }
        }
      } catch (err) {
        log.warn('ws', 'quote validation failed', { err: err.message });
        quote = null;
        replyRecipientId = null;
      }

      // #694: verify ownership of every referenced attachment before
      // linking — each id must belong to this app + this user and be
      // unlinked. Any miss drops the whole send (hostile/stale client).
      let attRows = [];
      if (attIds.length) {
        const { rows: found } = await pool.query(
          `SELECT id, kind, filename, size_bytes, meta
             FROM chat_message_attachments
            WHERE id = ANY($1) AND app_id = $2 AND user_id = $3 AND message_id IS NULL`,
          [attIds, client.appId, client.user.id]
        );
        if (found.length !== attIds.length) {
          log.warn('ws', 'chat message dropped: attachment ownership check failed', {
            appId: client.appId, userId: client.user.id,
            requested: attIds.length, found: found.length,
          });
          return { ok: false, code: 'attachment_not_owned' };
        }
        // Preserve the client's send order (the SELECT doesn't).
        attRows = attIds.map((id) => found.find((r) => r.id === id));
      }

      const metadata = (quote || attRows.length) ? {} : null;
      if (quote) metadata.quote = quote;
      if (attRows.length) {
        // Render-time summary rides in the message row's metadata so
        // history loads and broadcasts need no join; the bytea rows are
        // only touched by the serve routes.
        metadata.attachments = attRows.map((r) => ({
          id: r.id, kind: r.kind, filename: r.filename, sizeBytes: r.size_bytes,
          ...(r.meta ? { meta: r.meta } : {}),
        }));
      }

      // #2236: `client.postedVia` is 'agent' when the JSON write route was
      // reached with a Homeroom MCP connector credential (routes/chat.js
      // derives it from the request, never from the body). A browser
      // socket has no such field, so its rows stay NULL — a person typing.
      const postedVia = client.postedVia === 'agent' ? 'agent' : null;

      const insertSql = `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref, posted_via)
         VALUES ($1, $2, $3, 'message', $4, $5, $6, $7)
         RETURNING id, created_at`;
      // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
      const insertParams = [client.appId, client.user.id, content, JSON.stringify(metadata || {}),
        thread ? thread.type : null, thread ? thread.ref : null, postedVia];
      let rows;
      if (attRows.length) {
        // Insert + link atomically — a half-linked send would render
        // chips that 404 while the orphan sweeper still owns the rows.
        const cx = await pool.connect();
        try {
          await cx.query('BEGIN');
          ({ rows } = await cx.query(insertSql, insertParams));
          await cx.query(
            `UPDATE chat_message_attachments SET message_id = $1 WHERE id = ANY($2)`,
            [rows[0].id, attIds]
          );
          await cx.query('COMMIT');
        } catch (err) {
          try { await cx.query('ROLLBACK'); } catch { /* connection gone */ }
          throw err;
        } finally {
          cx.release();
        }
      } else {
        ({ rows } = await pool.query(insertSql, insertParams));
      }

      // #2387 follow-up: a reply in a reply thread is drawn in the general
      // stream as a line naming the message its thread hangs off.
      let threadRoot = null;
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        const root = await appChat.findThreadRoot(pool, client.appId, thread.ref);
        if (root) {
          threadRoot = {
            id: Number(root.id), username: root.username || null,
            content: root.deleted_at ? '' : appChat.snippet(root.content), deleted: !!root.deleted_at,
          };
        }
      }

      const outMsg = {
        type: 'chat',
        id: rows[0].id,
        userId: client.user.id,
        username: client.user.username,
        content,
        msgType: 'message',
        ...(metadata ? { metadata } : {}),
        ...(thread ? { thread } : {}),
        ...(threadRoot ? { threadRoot } : {}),
        createdAt: rows[0].created_at,
        // Always present on a human row, so a live row and a loaded one
        // carry the same fact (`posted_via` on the REST payload).
        postedVia,
      };

      await broadcastFromSender(pool, client.appId, outMsg, client.user.id);
      // A person answering on an issue's thread is exactly what the Homeroom
      // bot waits for; a system row (a claim, a bounty) is not a message.
      if (thread && thread.type === 'issue') noteIssueActivityForBot(client.appId, thread.ref, 'thread');
      // #3264: a reply in the discussion of the bot's own proposal.
      if (thread && thread.type === 'session') noteProposalActivityForBot(pool, client.appId, thread.ref);
      // #2387: a reply thread grew — every row showing its root redraws its
      // "N replies" line from this frame.
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        await broadcastThreadSummary(pool, client.appId, thread.ref, client.user.id);
      }

      events.record(pool, {
        type: events.EVENT_TYPES.CHAT_MESSAGE_SENT,
        userId: client.user.id,
        appId: client.appId,
      });

      // #2387: everyone who already got a more specific row for this message
      // (quoted → 'reply', @named → 'mention'). A reply-thread participant in
      // this set gets that row, not a second 'thread_reply' one.
      const directlyNotified = new Set();

      // #15: reply notification — ping the author of the quoted message
      // or PR (no-op for self-quotes and authorless system rows).
      try {
        const replyRows = await notifications.createReplyNotification(pool, {
          appId: client.appId,
          replyMessageId: rows[0].id,
          senderId: client.user.id,
          recipientId: replyRecipientId,
        });
        for (const r of replyRows) directlyNotified.add(Number(r.user_id));
        if (replyRows.length) {
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocked
                  WHERE blocked.blocker_id = n.user_id
                    AND blocked.blocked_user_id = n.source_user_id
               )`,
            [replyRows.map((r) => r.id)]
          );
          for (const row of hydrated) {
            pushNotificationToUser(row.user_id, {
              type: 'notification_new',
              notification: notifications.serialize(row),
            });
          }
        }
      } catch (err) {
        log.warn('ws', 'reply notify failed', { err: err.message });
      }

      // Fan out @mention notifications after the chat echo so UI order
      // stays predictable (everyone sees the message first, target user
      // then sees the bell-badge update).
      try {
        const notifRows = await notifications.createMentionNotifications(pool, {
          appId: client.appId,
          chatMessageId: rows[0].id,
          senderId: client.user.id,
          content,
        });
        for (const r of notifRows) directlyNotified.add(Number(r.user_id));
        if (notifRows.length) {
          // Hydrate with app/sender info so the client can render the
          // dropdown item immediately without another fetch. Mirror the
          // column set of notifications.listForUser so the same
          // serialize() works for both fresh and history rows — kudos
          // added session_id / pr_title / pr_number on top of the
          // original mention shape.
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    cm.thread_type, cm.thread_ref,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocked
                  WHERE blocked.blocker_id = n.user_id
                    AND blocked.blocked_user_id = n.source_user_id
               )`,
            [notifRows.map((r) => r.id)]
          );
          for (const row of hydrated) {
            pushNotificationToUser(row.user_id, {
              type: 'notification_new',
              notification: notifications.serialize(row),
            });
          }
        }
      } catch (err) {
        log.warn('ws', 'mention notify failed', { err: err.message });
      }

      // #2387: a reply in a reply thread pings the root's author and the
      // earlier repliers ('thread_reply'), minus the sender and anybody the
      // two blocks above already reached — a mention wins.
      if (thread && thread.type === appChat.MESSAGE_THREAD) {
        try {
          const threadRows = await notifications.createThreadReplyNotifications(pool, {
            appId: client.appId,
            replyMessageId: rows[0].id,
            rootId: thread.ref,
            senderId: client.user.id,
            excludeUserIds: [...directlyNotified],
          });
          await Promise.all(threadRows.map((row) => notifications.hydrateAndPush(pool, row)));
        } catch (err) {
          log.warn('ws', 'thread reply notify failed', { err: err.message });
        }
      }

      // Posting a message in this app's group chat is the "I've engaged
      // with this thread" action: clear every unread mention/reply/reaction
      // notification this user has for this app (the reply-clears-all
      // behavior). Confirmed in the DB, idempotent, and non-fatal — a
      // notification hiccup must never affect the chat send. On >=1 row
      // cleared, fan out notifications_changed so the sender's bell badge +
      // other tabs (and their chat dots) re-sync.
      try {
        const cleared = await notifications.markReadForAction(
          pool, client.user.id, 'message_sent', client.appId
        );
        if (cleared > 0) {
          pushNotificationToUser(client.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('ws', 'message_sent auto-dismiss failed', {
          appId: client.appId, userId: client.user.id, err: err.message,
        });
      }
      // #2387: posting in the general stream is reading it — the poster's
      // cursor moves forward to their own message (never back). A thread
      // reply is not in the general stream and leaves the cursor alone.
      if (!thread) {
        try {
          await appChat.advanceReadCursor(pool, client.appId, client.user.id, rows[0].id);
        } catch (err) {
          log.warn('ws', 'read cursor advance failed', {
            appId: client.appId, userId: client.user.id, err: err.message,
          });
        }
      }
      // WebSocket callers intentionally ignore this value. The JSON chat
      // route uses it to return the exact row produced by this canonical
      // mutation path instead of duplicating persistence and fan-out logic.
      return { ok: true, message: outMsg };
    }

    // Message editing: the author rewrites the content of one of their own
    // ordinary chat messages. Canonical mutation path (same as 'chat' /
    // 'react'); the socket is already scoped to the app room and gated by
    // appAccess.checkAppAccess(...,'collab') at connect time.
    // Inbound: { type: 'edit', messageId, content }.
    case 'edit': {
      const messageId = Number(msg.messageId);
      if (!Number.isInteger(messageId) || messageId <= 0) return;
      // Mirror the send path: trim (drops leading/trailing whitespace and
      // blank lines) then cap at MAX_CHAT_LEN. An empty edit is rejected —
      // editing is not a deletion path.
      if (!msg.content || !msg.content.trim()) return;
      const content = msg.content.trim().substring(0, MAX_CHAT_LEN);

      // Authorization (enforced server-side so a hand-crafted request can't
      // edit another user's message or a system/vote/conflict/spec_share
      // row): the row must exist in this app, belong to the editor, and be
      // an ordinary 'message'.
      const { rows } = await pool.query(
        `SELECT user_id, msg_type, thread_type, thread_ref, deleted_at, moderation_hidden_at
           FROM chat_messages WHERE id = $1 AND app_id = $2`,
        [messageId, client.appId]
      );
      if (!rows.length) {
        log.warn('ws', 'edit dropped: message not found in app', {
          appId: client.appId, userId: client.user.id, messageId,
        });
        return;
      }
      const row = rows[0];
      if (row.moderation_hidden_at || row.user_id !== client.user.id || row.msg_type !== 'message') {
        log.warn('ws', 'edit rejected: not author or not an editable message', {
          appId: client.appId, userId: client.user.id, messageId, msgType: row.msg_type,
        });
        return;
      }
      // #2387: a deleted message stays deleted — an edit is not a way back.
      if (row.deleted_at) return { ok: false, code: 'message_deleted' };

      // Leave metadata (the reply quote) untouched so a reply still points
      // at what it replied to, and reactions (keyed on message id) survive.
      const { rows: upd } = await pool.query(
        `UPDATE chat_messages SET content = $1, edited_at = NOW()
          WHERE id = $2 AND deleted_at IS NULL AND moderation_hidden_at IS NULL RETURNING edited_at`,
        [content, messageId]
      );
      // Deleted between the check and the write.
      if (!upd.length) return { ok: false, code: 'message_deleted' };
      const editedAt = upd[0].edited_at;

      // NOTE: we intentionally do NOT re-fire createMentionNotifications for
      // edits in this iteration — a brand-new @mention introduced by an edit
      // won't notify. See the spec's "Deferred work".

      // Echo the row's thread scope (when set) so thread-scoped edits route
      // to the right render target, mirroring the 'chat' broadcast.
      const thread = row.thread_type
        ? { type: row.thread_type, ref: row.thread_ref }
        : null;
      await broadcastFromSender(pool, client.appId, {
        type: 'chat_edit',
        messageId,
        content,
        editedAt,
        ...(thread ? { thread } : {}),
      }, client.user.id);
      break;
    }

    // #25: emoji reaction toggle. Slack-model — a user may stack multiple
    // distinct emoji on one message; the same emoji twice toggles it off.
    // The socket is already scoped to an app room, so we only need to
    // confirm the message lives in this app before mutating.
    case 'react': {
      const messageId = Number(msg.messageId);
      const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
      // Keep it a single short token (no whitespace) — the picker only
      // ever sends one emoji, and this bounds what lands in the column.
      if (!Number.isInteger(messageId) || !emoji || emoji.length > 16 || /\s/.test(emoji)) return;

      const { rows: mrows } = await pool.query(
        `SELECT m.user_id FROM chat_messages m
          WHERE m.id = $1 AND m.app_id = $2
            AND m.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks blocked
               WHERE blocked.blocker_id = $3 AND blocked.blocked_user_id = m.user_id
            )`,
        [messageId, client.appId, client.user.id]
      );
      // Missing, blocked, or (#2387) deleted: nothing to react to.
      if (!mrows.length) return { ok: false, code: 'message_unavailable' };
      const authorId = mrows[0].user_id;

      const { rowCount: deleted } = await pool.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, client.user.id, emoji]
      );
      let added = false;
      if (!deleted) {
        await pool.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
          [messageId, client.user.id, emoji]
        );
        added = true;
      }

      const reactions = await getMessageReactions(pool, messageId);
      await broadcastFromSender(pool, client.appId,
        { type: 'reaction', messageId, reactions }, client.user.id);

      // Notify the author only when a reaction is *added* (not removed),
      // and never for self-reactions or authorless system rows.
      if (added && authorId) {
        try {
          const notifRows = await notifications.createReactionNotification(pool, {
            appId: client.appId,
            messageId,
            senderId: client.user.id,
            recipientId: authorId,
            emoji,
          });
          if (notifRows.length) {
            const { rows: hydrated } = await pool.query(
              `SELECT n.id, n.kind, n.read_at, n.created_at,
                      n.app_id, a.slug AS app_slug, a.name AS app_name,
                      n.chat_message_id, cm.content AS message_content,
                      cm.thread_type, cm.thread_ref,
                      n.session_id, cs.pr_title, cs.pr_number,
                      su.username AS source_username, n.user_id, n.detail
               FROM notifications n
               LEFT JOIN apps a ON a.id = n.app_id
               LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
               LEFT JOIN chat_sessions cs ON cs.id = n.session_id
               LEFT JOIN users su ON su.id = n.source_user_id
               WHERE n.id = ANY($1::int[])
               AND NOT EXISTS (SELECT 1 FROM user_app_blocks app_block WHERE app_block.user_id = n.user_id AND app_block.app_id = n.app_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM user_blocks blocked
                    WHERE blocked.blocker_id = n.user_id
                      AND blocked.blocked_user_id = n.source_user_id
                 )`,
              [notifRows.map((r) => r.id)]
            );
            for (const row of hydrated) {
              pushNotificationToUser(row.user_id, {
                type: 'notification_new',
                notification: notifications.serialize(row),
              });
            }
          }
        } catch (err) {
          log.warn('ws', 'reaction notify failed', { err: err.message });
        }
      }
      break;
    }

    // #2387: the author deletes one of their own messages. Inbound:
    // { type: 'delete', id } — and the REST route
    // DELETE /api/apps/:slug/messages/:id lands here too, so the socket and
    // the route cannot disagree about what deleting does. Not in
    // WRITE_MSG_TYPES on purpose: taking back your own words needs only the
    // view access the socket already has, so someone who has since lost
    // collaborator access can still remove what they wrote. Authorship is
    // the gate (services/app-chat.js deleteOwnMessage).
    case 'delete': {
      const messageId = appChat.positiveInt(msg.id);
      if (!messageId) return { ok: false, code: 'not_found' };
      const result = await appChat.deleteOwnMessage(pool, {
        appId: client.appId, userId: client.user.id, messageId,
      });
      if (!result.ok) {
        log.warn('ws', 'delete rejected', {
          appId: client.appId, userId: client.user.id, messageId, code: result.code,
        });
        return result;
      }
      if (result.alreadyDeleted) return result;
      const { message } = result;
      await broadcastFromSender(pool, client.appId, {
        type: 'chat_delete',
        id: message.id,
        thread_type: message.thread_type,
        thread_ref: message.thread_ref,
      }, client.user.id);
      // A reply went: its thread's count and faces change with it.
      if (message.thread_type === appChat.MESSAGE_THREAD && message.thread_ref) {
        await broadcastThreadSummary(pool, client.appId, message.thread_ref, client.user.id);
      }
      // Notification rows pointing at the message went in the same
      // transaction; the people who held them re-sync their bells.
      for (const userId of result.clearedUserIds) {
        pushNotificationToUser(userId, { type: 'notifications_changed' });
      }
      return result;
    }

    case 'typing': {
      // #194: pass the (shape-checked) thread along so typing indicators
      // don't bleed between general chat and threads. No DB lookup —
      // typing is ephemeral and the worst a bogus ref does is show a
      // typing line in a thread nobody has open.
      const t = msg.thread;
      const typingThread = (t && typeof t === 'object'
        && THREAD_TYPES.includes(t.type)
        && Number.isInteger(Number(t.ref)) && Number(t.ref) > 0)
        ? { type: t.type, ref: Number(t.ref) } : null;
      await broadcastFromSender(pool, client.appId, {
        type: 'typing',
        userId: client.user.id,
        username: client.user.username,
        ...(typingThread ? { thread: typingThread } : {}),
      }, client.user.id, client.ws);
      break;
    }

    default:
      break;
  }
}

// #25: aggregate reactions for a message → [{ emoji, count, users:[username] }]
// ordered by first-reacted. `users` powers both the per-viewer "mine"
// highlight (membership check) and the who-reacted tooltip, so history and
// live broadcasts can share one shape.
async function getMessageReactions(pool, messageId) {
  const { rows } = await pool.query(
    `SELECT mr.emoji, COUNT(*)::int AS count,
            COALESCE(array_agg(u.username ORDER BY mr.created_at), '{}') AS users
     FROM message_reactions mr JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = $1
     GROUP BY mr.emoji
     ORDER BY MIN(mr.created_at)`,
    [messageId]
  );
  return rows.map((r) => ({ emoji: r.emoji, count: r.count, users: r.users || [] }));
}

// Batch variant for history hydration: messageIds → { [id]: reactions[] }.
async function getReactionsForMessages(pool, messageIds, viewerId = null) {
  if (!messageIds.length) return {};
  const { rows } = await pool.query(
    `SELECT mr.message_id, mr.emoji, COUNT(*)::int AS count,
            COALESCE(array_agg(u.username ORDER BY mr.created_at), '{}') AS users
     FROM message_reactions mr JOIN users u ON u.id = mr.user_id
     WHERE mr.message_id = ANY($1::int[])
       AND ($2::int IS NULL OR NOT EXISTS (
         SELECT 1 FROM user_blocks blocked
          WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = mr.user_id
       ))
     GROUP BY mr.message_id, mr.emoji
     ORDER BY mr.message_id, MIN(mr.created_at)`,
    [messageIds, viewerId]
  );
  const out = {};
  for (const r of rows) {
    (out[r.message_id] = out[r.message_id] || []).push({ emoji: r.emoji, count: r.count, users: r.users || [] });
  }
  return out;
}

// `metadata` is an optional plain object persisted to chat_messages.metadata
// (JSONB) and echoed on the live broadcast. Used e.g. by the vote-activity
// lines (promote / vote cast) to carry { vote: { sessionId, prNumber } } so
// the group-chat client can render live vote buttons inline on the row.
// #194: `thread` ({ type: 'issue'|'session'|'governance', ref }) scopes the
// system message into that thread (used by the per-vote activity rows,
// which post into the proposal's thread). Callers are trusted — no ref
// validation here.
//
// A CHANNEL IS WHAT PEOPLE SAID. With no thread there is nothing to write:
// the main stream is the app's channel (the hub's Channel card, the Messages
// room), and Homeroom's activity — a proposal put up for a vote, a merge, a
// check verdict, a setting changed, main going red — is no longer a line in
// it, nor in #general. The story of one proposal, request or decision is
// told in its own thread, which every caller names. The app-wide notices
// that have no thread are shown where that state lives: main's suite and a
// stalled release as banners on the project page (dev-board/board-frame.tsx),
// and the Friday card and settings changed lately in the Workshop's notices
// panel (services/app-notices.js, read from `events`). A call with no thread
// is refused here rather than trusted to the callers.
// db/migrate.js clearAutomatedChannelLines removes the lines written before.
async function sendSystemMessage(pool, appId, content, msgType = 'system', metadata = null, thread = null) {
  if (!thread) return null;
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    // metadata is NOT NULL DEFAULT '{}', so always pass a JSON object.
    [appId, content, msgType, JSON.stringify(metadata || {}), thread.type, thread.ref]
  );

  broadcast(appId, {
    type: 'chat',
    id: rows[0].id,
    userId: null,
    username: null,
    content,
    msgType,
    ...(metadata ? { metadata } : {}),
    thread,
    createdAt: rows[0].created_at,
  });
  // #1688: the row, for a caller that hangs something off the message — the
  // "needs a conversation" prompt names people, and their mention rows point
  // at it. Every existing caller ignores the return.
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

/**
 * #3288: a thread post from a synthetic account (the Homeroom bot), written
 * and broadcast as an ORDINARY message from that user, so the chat draws it
 * as a bubble with a name and not as a centred system line.
 *
 * Deliberately NOT handleMessage. That is the path for a person at a
 * keyboard, and three of its effects are wrong for text a model wrote:
 *   - it turns every `@name` in the body into a notification, so a reply
 *     that quoted a handle would notify whoever owns it (the caller writes
 *     the one mention it means, for the person it answers);
 *   - it wakes the Homeroom bot on issue and proposal threads, and this is
 *     the bot talking;
 *   - its collaborator and join gates are for people; the bot is on an app
 *     because the app is in its live list.
 * What it keeps is the row and the frame: `msg_type = 'message'`, the
 * author's user_id, and the same `chat` payload handleMessage broadcasts,
 * through broadcastFromSender so a viewer who blocked the account does not
 * receive it. Thread posts only, like sendSystemMessage.
 *
 * `msgType` may also be 'spec_share': the bot's spec, drawn as the same spec
 * card a person's "Share to group" posts (metadata.specShare), with the
 * card's summary line as its content. Nothing else.
 */
const BOT_MESSAGE_TYPES = new Set(['message', 'spec_share']);
async function sendBotMessage(pool, appId, { user, content, metadata = null, thread = null, msgType = 'message' } = {}) {
  if (!thread || !user || !Number.isInteger(Number(user.id))) return null;
  const text = String(content || '').trim().slice(0, MAX_CHAT_LEN);
  if (!text) return null;
  const kind = BOT_MESSAGE_TYPES.has(msgType) ? msgType : 'message';
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, $7, $4, $5, $6)
     RETURNING id, created_at`,
    [appId, Number(user.id), text, JSON.stringify(metadata || {}), thread.type, thread.ref, kind]
  );
  await broadcastFromSender(pool, appId, {
    type: 'chat',
    id: rows[0].id,
    userId: Number(user.id),
    username: user.username,
    content: text,
    msgType: kind,
    ...(metadata ? { metadata } : {}),
    thread,
    createdAt: rows[0].created_at,
    postedVia: null,
  }, Number(user.id));
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

function getOnlineUsers(appId) {
  const room = rooms.get(appId);
  if (!room) return [];
  const seen = new Set();
  const users = [];
  for (const client of room) {
    if (!seen.has(client.user.id)) {
      seen.add(client.user.id);
      users.push({ id: client.user.id, username: client.user.username });
    }
  }
  return users;
}

// App-scoped global broadcast with visibility filtering. Public-view
// apps keep the broadcast-to-all fast path; for a view-private app the
// payload (name, status, PR titles...) only goes to admins + members.
// Membership comes from appAccess.getWsVisibility's 10s TTL cache, so
// this is at most one query per app per window. Fail-closed: if the
// lookup errors we drop the event (a stale UI beats a privacy leak).
// The visibility lookup runs on EVERY instance rather than being resolved once
// and shipped: membership decides who may see this, each pod holds its own
// sockets and its own 10s cache, and a fail-closed rule has to be able to fail
// closed locally. So the bus carries the routing, not the answer.
function deliverGlobalScoped(payload, { appId = null, appSlug = null } = {}) {
  if (!_pool || (appId == null && !appSlug)) {
    deliverGlobal(payload);
    return;
  }
  appAccess.getWsVisibility(_pool, { appId, appSlug })
    .then((info) => {
      if (!info || info.suspended) return; // no ordinary activity from a suspended app
      if (!info.viewPrivate && !info.blockedUserIds?.size) {
        deliverGlobal(payload);
        return;
      }
      const json = JSON.stringify(payload);
      for (const client of globalClients) {
        if (client.ws.readyState !== 1) continue;
        if (!info.blockedUserIds?.has(client.user.id)
            && (!info.viewPrivate || client.user.isAdmin || info.memberIds.has(client.user.id))) {
          client.ws.send(json);
        }
      }
    })
    .catch((err) => {
      log.warn('ws', 'scoped broadcast dropped', { type: payload.type, err: err.message });
    });
}

function broadcastGlobalScoped(payload, opts = {}) {
  deliverGlobalScoped(payload, opts);
  wsBus.publish('scoped', { appId: opts.appId ?? null, appSlug: opts.appSlug ?? null }, payload);
}

// Push an app status update to all connected clients (filtered for
// view-private apps). `errorReason` (#416) is the concise one-line
// failure reason only — the full build log stays behind the gated
// GET /api/apps/:slug payload.
function pushAppStatusUpdate(app) {
  broadcastGlobalScoped({
    type: 'app_status',
    appId: app.id,
    slug: app.slug,
    status: app.status,
    url: app.url || null,
    errorReason: app.errorReason || null,
  }, { appId: app.id, appSlug: app.slug });
}

// Push one creation-phase update for an app that is still 'creating'.
//
// Rides the SAME `app_status` message the terminal transitions above
// use — clients already receive and dispatch it — with `phase` as the
// only new field. Scoped identically to pushAppStatusUpdate, which is
// the whole reason this does not live in app-deploy-status.js: that
// module broadcasts unscoped, and a brand-new app may be view-private.
//
// `status` is pinned to 'creating' rather than read off the row: the
// caller is inside createApp, where that is the only status the row can
// have, and a stale read here would race the terminal update.
function pushAppCreationPhase(app) {
  broadcastGlobalScoped({
    type: 'app_status',
    appId: app.id,
    slug: app.slug,
    status: 'creating',
    url: null,
    errorReason: null,
    phase: app.phase,
  }, { appId: app.id, appSlug: app.slug });
}

// Board-change listeners (services/workshop-themes.js registers one from
// server.js). A card arriving on, or leaving, an app's board is what the
// Workshop's placement stage waits for, and every such change already
// passes through pushSessionUpdate or pushIssueUpdate — so the hook lives
// here rather than at the thirty call sites. Listeners are told only which
// app; they read the board themselves. A listener that throws is logged
// and never breaks the broadcast.
const boardChangeListeners = [];
function onBoardChange(fn) {
  if (typeof fn === 'function') boardChangeListeners.push(fn);
}
function noteBoardChange(data) {
  if (!data || (data.appId == null && !data.appSlug)) return;
  for (const fn of boardChangeListeners) {
    try {
      fn({ appId: data.appId ?? null, appSlug: data.appSlug ?? null });
    } catch (err) {
      log.warn('ws', 'board change listener failed', { message: err.message });
    }
  }
}

function pushSessionUpdate(data) {
  broadcastGlobalScoped({ type: 'session_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
  noteBoardChange(data);
}

// #1038: live working-state for one session (services/session-state.js).
// Scoping is the whole point of having a dedicated helper rather than
// reusing broadcastGlobal: the payload names an app and a session, so an
// unscoped fan-out would tell every connected client that a private app
// has activity.
//
//   shared  → broadcastGlobalScoped, i.e. everyone who may VIEW the app
//             (which is exactly who already sees the shared session card
//             or the auto-run's issue card).
//   private → the owner's own sockets only. A session nobody else can see
//             must not announce itself, not even as an anonymous id.
//
// A payload with no resolved owner AND no app (the row lookup failed) is
// dropped rather than guessed at — failing closed matches
// broadcastGlobalScoped's own stance.
// Pure routing decision, exported so the privacy boundary is unit-testable
// without stubbing the socket registry. 'app' | 'user' | 'none'.
function sessionStateAudience(data) {
  if (!data) return 'none';
  if (data.shared && (data.appId != null || data.appSlug)) return 'app';
  if (data.userId != null) return 'user';
  return 'none';
}

function pushSessionState(data) {
  const payload = { type: 'session_state', ...data };
  switch (sessionStateAudience(data)) {
    case 'app':
      broadcastGlobalScoped(payload, { appId: data.appId, appSlug: data.appSlug });
      break;
    case 'user':
      pushToUser(data.userId, payload);
      break;
    default:
      log.debug('ws', 'session_state dropped: no audience', { sessionId: data.sessionId });
  }
}

function pushVoteUpdate(data) {
  broadcastGlobalScoped({ type: 'vote_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// PR kudos count changed. Fan out the new total + the giver's username
// (so the receiving client can append the new giver to its popover
// cache without a refetch). Same broadcast model as vote_update —
// every connected (and view-authorized) client gets the message and
// decides whether it cares.
function pushKudosUpdate(data) {
  broadcastGlobalScoped({ type: 'kudos_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Notify all clients that an app's metadata changed (e.g. renamed via vote).
function pushAppUpdate(data) {
  broadcastGlobalScoped({ type: 'app_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Notify all clients that an issue/rename-proposal was created, voted on,
// or closed for a given app — so their open vote panel refreshes in real
// time instead of only on page reload.
function pushIssueUpdate(data) {
  broadcastGlobalScoped({ type: 'issue_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
  // An edit or an unclaim names the GitHub issue; a create names the local
  // row, so routes/issues.js wakes the bot itself once the twin exists.
  if (data && data.issueNumber != null && data.appId != null
      && (data.action === 'updated' || data.action === 'unclaimed')) {
    noteIssueActivityForBot(data.appId, data.issueNumber, data.action);
  }
  noteBoardChange(data);
}

// The Workshop's grouping for an app moved — cards were placed into
// themes, or the themes were re-drafted (`stage`) — so every open Workshop
// re-fetches GET /api/apps/:slug/workshop-themes. Same scoping as the
// board's other fan-outs: the grouping is built from shared-visibility
// data, so a member of a view-private app may hear about it and nobody
// else.
function pushWorkshopUpdate(data) {
  broadcastGlobalScoped({ type: 'workshop_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// #613: the manual card order in a Dev-board column changed — fan out so
// every client with that app's board open re-pulls the order and repaints
// in real time (same broadcast model as vote_update). `column` names which
// column moved so the client could scope its repaint if it wanted; today it
// just triggers a full dev-data reload.
function pushBoardOrderUpdate(data) {
  broadcastGlobalScoped({ type: 'board_order_update', ...data },
    { appId: data.appId, appSlug: data.appSlug });
}

// Send a payload to every ADMIN /ws/events socket. Same `client.user.isAdmin`
// filter broadcastGlobalScoped applies for view-private apps, in the loop
// shape of pushNotificationToUser below. Used by the bulk container
// rollover (services/app-rollover.js): its progress payload is an
// operational inventory of every app on the box, so it must not go out over
// broadcastGlobal, which reaches every connected client. View-only admins
// are included deliberately — they can watch, they just can't start one.
function deliverToAdmins(payload) {
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user && client.user.isAdmin && client.ws.readyState === 1) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

// The return value counts THIS instance's admins, which is what every caller
// uses it for (a debug tally). It is not a cluster-wide count and does not
// claim to be.
function broadcastToAdmins(payload) {
  const sent = deliverToAdmins(payload);
  wsBus.publish('admins', null, payload);
  return sent;
}

// Send a payload to every /ws/events socket belonging to `userId`. Used for
// @mention delivery — a single user may have multiple tabs open — and, since
// #1038, for the owner-only fan-out of a private session's working state.
// `pushNotificationToUser` is kept as an alias so the notification call sites
// above (and any external caller) read naturally and don't have to churn.
function deliverToUser(userId, payload) {
  if (payload.type === 'app_blocks_changed') {
    appAccess.invalidateVisibility(payload.appId, payload.slug);
    if (payload.blocked) {
      for (const client of rooms.get(payload.appId) || []) {
        if (client.user.id === userId) client.ws.close(4004, 'App blocked');
      }
    }
  }
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user.id === userId && client.ws.readyState === 1) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

// One person's tabs are not guaranteed to land on one instance, so an
// @mention delivered only locally reaches whichever half of their sessions
// happens to share a pod with the emitter.
function pushToUser(userId, payload) {
  const sent = deliverToUser(userId, payload);
  wsBus.publish('user', { userId }, payload);
  // #2904: every read path announces itself with this event, so it is also
  // where the iOS icon badge learns the count moved. Only the emitting
  // instance gets here (bus peers call deliverToUser), so one change is one
  // debounced sync. Lazy and guarded: the badge is best-effort and must never
  // break the socket fan-out.
  if (payload && payload.type === 'notifications_changed') {
    try { require('./mobile-push').scheduleBadgeSync(userId); } catch {}
  }
  return sent;
}

// Platform conversations have no app room. Their service resolves a fresh
// active-member audience inside the same mutation and hands that snapshot to
// this helper, which fans out only through each member's authenticated global
// event sockets. Keeping this separate from broadcast()/broadcastGlobal()
// makes an accidental private-message app/global broadcast review-visible.
const CONVERSATION_EVENT_TYPES = new Set([
  'conversation_message_created',
  'conversation_message_updated',
  'conversation_reaction_updated',
  'conversation_read',
  'conversation_membership_changed',
  'conversation_typing',
]);

function pushConversationEvent(memberUserIds, payload, { excludeUserId = null } = {}) {
  if (!Array.isArray(memberUserIds) || !payload || typeof payload !== 'object'
      || Array.isArray(payload) || !CONVERSATION_EVENT_TYPES.has(payload.type)) {
    return 0;
  }
  const conversationId = Number(payload.conversationId);
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0
      || conversationId > 2147483647) {
    return 0;
  }
  const excluded = Number(excludeUserId);
  let sent = 0;
  const seen = new Set();
  for (const value of memberUserIds) {
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647
        || userId === excluded || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    sent += pushToUser(userId, payload);
  }
  return sent;
}

const pushNotificationToUser = pushToUser;

module.exports = { connectedUserIds, disconnectUser, attach, broadcast, _onBusMessage, broadcastGlobal, broadcastGlobalScoped, broadcastToAdmins, sendSystemMessage, sendBotMessage, getOnlineUsers, pushAppStatusUpdate, pushAppCreationPhase, pushSessionUpdate, pushSessionState, sessionStateAudience, pushVoteUpdate, pushKudosUpdate, pushAppUpdate, pushIssueUpdate, pushBoardOrderUpdate, pushWorkshopUpdate, onBoardChange, pushToUser, pushConversationEvent, pushNotificationToUser, pushPlatformVersion, getReactionsForMessages, validateThread, handleMessage, MAX_CHAT_LEN };
