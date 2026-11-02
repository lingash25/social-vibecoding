'use strict';

// Invite redemption, friend writes and the other one-click signed-in actions
// (leaving a conversation, accepting an invite, archiving or sharing a
// proposal, revoking a grant, ...) answer only the Homeroom page itself: a
// browser request marked by Sec-Fetch-Site as coming from anywhere else —
// including an app on a sibling subdomain, which the Lax session cookie
// does not stop — is refused. Clients that send no such header pass.
//
// Run with: node --test tests/same-site-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { sameOriginBrowserOnly } = require('../src/middleware/same-site-browser');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function withApp(fn) {
  const app = express();
  app.post('/write', sameOriginBrowserOnly, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/write`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a browser request from another site or origin is refused with 403', async () => {
  await withApp(async (url) => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      const res = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': site } });
      assert.equal(res.status, 403, site);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
  });
});

test('the Homeroom page itself, and a client that sends no header, pass', async () => {
  await withApp(async (url) => {
    const same = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(same.status, 200);
    const bare = await fetch(url, { method: 'POST' });
    assert.equal(bare.status, 200, 'native app, CLI and tests send no Sec-Fetch-Site');
  });
});

test('without Sec-Fetch-Site, an Origin other than the request\'s own is refused', async () => {
  await withApp(async (url) => {
    const { host } = new URL(url);
    const post = (headers) => fetch(url, { method: 'POST', headers });
    // A browser that predates Fetch Metadata, on a sibling app's subdomain.
    const sibling = await post({ origin: 'https://evil-app.onhomeroom.com' });
    assert.equal(sibling.status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403, 'an opaque origin is refused');
    assert.equal((await post({ origin: `https://${host}` })).status, 403, 'another scheme is another origin');
    assert.equal((await post({ origin: `http://${host}` })).status, 200, 'the request\'s own origin passes');
    // Behind the proxy the origin is the one the proxy received, e.g. a
    // staging preview's own host.
    const preview = 'usernode-2d5619--s1234.onhomeroom.com';
    const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-host': preview };
    assert.equal((await post({ ...proxied, origin: `https://${preview}` })).status, 200);
    assert.equal((await post({ ...proxied, origin: 'https://my.onhomeroom.com' })).status, 403);
    assert.equal((await post({})).status, 200, 'no Origin and no Sec-Fetch-Site: a non-browser client');
  });
});

test('invite redemption is guarded, after its rate limiter', () => {
  const src = read('src/routes/community-invites.js');
  assert.ok(src.includes(
    "router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter, sameOriginBrowserOnly, async",
  ));
});

test('every friend write is guarded', () => {
  const src = read('src/routes/friends.js');
  for (const route of [
    "router.post('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('request',",
    "router.delete('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('cancel',",
    "router.post('/api/friends/:userId/accept', friendshipLimiter, sameOriginBrowserOnly, write('accept',",
    "router.post('/api/friends/:userId/decline', friendshipLimiter, sameOriginBrowserOnly, write('decline',",
    "router.delete('/api/friends/:userId', friendshipLimiter, sameOriginBrowserOnly, write('unfriend',",
  ]) assert.ok(src.includes(route), route);
  assert.doesNotMatch(src, /router\.(post|delete)\([^\n]*friendshipLimiter, write\(/, 'no unguarded write');
});

// Every unsafe route under src/routes/** is accounted for: it carries the
// guard, sits under an admin prefix (server.js guards those writes as a
// block), or is listed in EXEMPT with the reason it cannot be sent from
// another page with the visitor's cookie. A new route fails here until
// someone decides which.
//
// Only POST needs the decision. PUT, PATCH and DELETE are not CORS-simple
// methods, so another origin cannot send one without a preflight, and no
// route here answers a preflight with credentials (public-cors.js allows
// none). Many of them carry the guard anyway, as a second layer.
const JSON_FIELD = 'requires a JSON body field: another origin cannot send one without a preflight';
const RAW = 'application/octet-stream body: not CORS-safelisted, so another origin needs a preflight';
const TOKEN = 'not cookie-authenticated: bearer, app, worker or partner token, webhook signature, OAuth client or public endpoint';
const OWN = 'has its own Origin/Sec-Fetch-Site check';
const FILTER = 'a method filter, rate limit or 404/405 fallback: changes nothing itself';

const EXEMPT = new Map([
  // Apple answers sign-in with a cross-site form POST by design
  // (response_mode=form_post). The route changes nothing: it hands the
  // fields to the GET callback, which counts only with the binder cookie of
  // the browser that started the trip.
  ['sign-in-providers.js POST /api/auth/oauth/apple/callback', 'the provider\'s own cross-site answer; it only redirects to the binder-checked GET'],
  ['sign-in-providers.js POST /api/auth/oauth/finish', JSON_FIELD],
  // Inside the Homeroom app: the start needs `from`, the finish the state and
  // the ID token, each in a JSON body.
  ['sign-in-providers.js POST /api/auth/oauth/:provider/native/start', JSON_FIELD],
  ['sign-in-providers.js POST /api/auth/oauth/:provider/native', JSON_FIELD],
  // …and a failed app sheet's report, the state again in a JSON body; it
  // writes one log line for a state that is still live, and nothing else.
  ['sign-in-providers.js POST /api/auth/oauth/:provider/native/failed', JSON_FIELD],
  // WP-E: a mail client's one-click unsubscribe (RFC 8058) is a cross-site
  // POST by design. It carries no session; the HMAC token in its query is
  // the whole of the check, and all it can do is turn activity mail off.
  ['activity-mail.js POST /mail/unsubscribe', 'a mail client\'s one-click unsubscribe: sessionless, the signed token in the link is the check'],
  ['agent-session-drafts.js POST /api/agent-sessions/:id/drafts', JSON_FIELD],
  ['agent-sessions.js POST /api/agent-sessions/:id/attachments', RAW],
  ['agent-sessions.js POST /api/agent-sessions/:id/turns', JSON_FIELD],
  ['app-files.js POST /api/apps/:slug/files', RAW],
  ['app-llm-proxy.js POST `${ROUTE_PREFIX}*`', TOKEN],
  ['app-permissions.js POST /api/me/permission-grants', JSON_FIELD],
  ['app-storage.js POST /api/app-storage/files', TOKEN],
  ['approvers.js POST /api/apps/:slug/approver-invites', JSON_FIELD],
  ['apps.js POST /api/apps', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/fork', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/secret-declaration-pr', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/rename', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/lock', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/visibility-pr', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/admins-pr', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/governance-pr', JSON_FIELD],
  // #4666: who can see it and how changes are approved, one proposal, read
  // from a JSON body like the two single-block PRs it stands in for.
  ['apps.js POST /api/apps/:slug/who-decides-pr', JSON_FIELD],
  // #4417: a topics proposal needs its `op` (and the topic's fields) in a
  // JSON body, like the rename and visibility PRs beside it.
  ['apps.js POST /api/apps/:slug/topics-pr', JSON_FIELD],
  // Versions: whether a version gets its original's updates, as a proposal;
  // `follow` is a boolean read from a JSON body.
  ['versions.js POST /api/apps/:slug/follow-pr', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/favorite', JSON_FIELD],
  ['apps.js POST /api/apps/:slug/membership', JSON_FIELD],
  ['auth.js POST /api/auth/login', JSON_FIELD],
  ['auth.js POST /api/auth/otp/request', JSON_FIELD],
  ['auth.js POST /api/auth/otp/verify', JSON_FIELD],
  ['auth.js POST /api/auth/otp/set-password', JSON_FIELD],
  // #4594: the release mail's one-time link, read from the JSON body.
  ['auth.js POST /api/auth/release-link', JSON_FIELD],
  ['auth.js POST /api/auth/register', JSON_FIELD],
  ['auth.js POST /api/me/api-key', JSON_FIELD],
  ['auth.js POST /api/me/password', JSON_FIELD],
  ['auth.js POST /api/me/ai-progress-estimate', JSON_FIELD],
  ['auth.js POST /api/me/session-bridge', JSON_FIELD],
  // New Needs you, the experimental review flow: the same JSON `enabled`.
  ['auth.js POST /api/me/review-flow', JSON_FIELD],
  ['auth.js POST /api/auth/wallet-check', JSON_FIELD],
  ['auth.js POST /api/auth/wallet-verify', JSON_FIELD],
  ['auth.js POST /api/auth/wallet-reset-verify', JSON_FIELD],
  ['auth.js POST /api/auth/password-reset/request', JSON_FIELD],
  ['auth.js POST /api/auth/password-reset/confirm', JSON_FIELD],
  ['auth.js POST /api/me/wallet-change-password', JSON_FIELD],
  ['auth.js POST /api/auth/wallet-register', JSON_FIELD],
  ['auth.js POST /api/auth/wallet-link-login', JSON_FIELD],
  // SESSION_MINT_PATHS names it for the live-session guard; the handler is
  // sign-in-providers.js's, below.
  ['auth.js POST /api/auth/oauth/finish', JSON_FIELD],
  ['auth.js POST /api/auth/oauth/:provider/native', JSON_FIELD],
  // Phone sign-in (routes/phone-auth.js). SESSION_MINT_PATHS names verify
  // and finish for the live-session guard, so auth.js's registrations of
  // those two paths are listed here the same way; the handlers are
  // phone-auth.js's, and every one of them carries JSON body fields.
  ['auth.js POST /api/auth/phone/verify', JSON_FIELD],
  ['auth.js POST /api/auth/phone/finish', JSON_FIELD],
  ['phone-auth.js POST /api/auth/phone/request', JSON_FIELD],
  ['phone-auth.js POST /api/auth/phone/verify', JSON_FIELD],
  ['phone-auth.js POST /api/auth/phone/finish', JSON_FIELD],
  ['board-order.js POST /api/apps/:slug/board-order', JSON_FIELD],
  ['chat-drafts.js POST /api/sessions/:id/drafts', JSON_FIELD],
  ['chat.js POST /api/apps/:slug/messages', JSON_FIELD],
  ['chat.js POST /api/apps/:slug/chat-attachments', RAW],
  ['cli-agent.js POST /attach', TOKEN],
  ['cli-agent.js POST /heartbeat', TOKEN],
  ['cli-agent.js POST /turns/:id/accept', TOKEN],
  ['cli-agent.js POST /turns/:id/decline', TOKEN],
  ['cli-agent.js POST /turns/:id/progress', TOKEN],
  ['cli-agent.js POST /turns/:id/commit', TOKEN],
  ['cli-agent.js POST /turns/:id/result', TOKEN],
  ['cli-agent.js POST /detach', TOKEN],
  ['cli-auth.js POST /api/cli/device/code', JSON_FIELD],
  ['cli-auth.js POST /api/cli/device/token', JSON_FIELD],
  ['cli-auth.js POST /api/cli/device/approve', OWN],
  ['collaborators.js POST /api/apps/:slug/invites', JSON_FIELD],
  ['conversations.js POST /api/conversations', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/respond', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/members', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/messages', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/messages/:messageId/reactions', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/read', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/unread', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/typing', JSON_FIELD],
  ['conversations.js POST /api/conversations/:id/messages/:messageId/report', JSON_FIELD],
  ['demo-mode.js POST /api/apps/:slug/demo/propose', JSON_FIELD],
  ['dev-flow.js POST /api/apps/:slug/external-tasks', OWN],
  ['dev-flow.js POST /api/apps/:slug/external-tasks/:id/submit', OWN],
  ['dev-flow.js POST /api/apps/:slug/external-tasks/:id/discard', OWN],
  ['dev-flow.js POST /api/apps/:slug/external-tasks/:id/submit-update', OWN],
  ['feedback.js POST /api/feedback/title', JSON_FIELD],
  ['feedback.js POST /api/feedback/screenshot', RAW],
  ['feedback.js POST /api/feedback/video', RAW],
  ['feedback.js POST /api/feedback', JSON_FIELD],
  ['github-webhook.js POST /api/github/webhook', TOKEN],
  // #4264: a coding agent's sandbox, authenticated by the task's one-time
  // upload token in Authorization; no cookie is read.
  ['external-agent-patch-upload.js POST /api/external-tasks/:taskId/patch', TOKEN],
  // A coding agent's machine, authenticated by the connector upload's
  // one-time token in Authorization; no cookie is read.
  ['connector-uploads.js POST /api/connector-uploads/:uploadId', TOKEN],
  // A platform preview's own process, in the cluster, authenticated by the
  // credential production gave it (services/preview-projects.js); no cookie
  // is read, and a call through any proxy is refused.
  ['preview-projects.js PUT /api/preview-projects/:slug', TOKEN],
  ['preview-projects.js POST /api/preview-projects/:slug/build', TOKEN],
  ['preview-projects.js POST /api/preview-projects/:slug/deploy', TOKEN],
  ['preview-projects.js POST /api/preview-projects/:slug/restart', TOKEN],
  ['preview-projects.js DELETE /api/preview-projects/:slug', TOKEN],
  ['mail-webhooks.js POST /api/mail/webhooks/resend', 'Resend raw-body Svix signature; no cookie or browser session authorizes a callback'],
  ['sms-webhooks.js POST /api/sms/webhooks/brevo', 'Brevo\'s SMS webhook bearer token (BREVO_SMS_WEBHOOK_TOKEN); no cookie or browser session authorizes a callback'],
  ['sms-webhooks.js POST /api/sms/webhooks/twilio', 'Twilio\'s X-Twilio-Signature HMAC keyed by TWILIO_AUTH_TOKEN over TWILIO_STATUS_CALLBACK_URL; no cookie or browser session authorizes a callback'],
  ['alerts-webhook.js POST /api/internal/alerts', 'Alertmanager\'s bearer token (ALERTMANAGER_WEBHOOK_TOKEN); no cookie or browser session authorizes a call'],
  ['internal.js POST /api/internal/shots/:runId/shot', TOKEN],
  ['internal.js POST /api/internal/shots/:runId/closeup', TOKEN],
  ['internal.js POST /api/internal/shots/:runId/skip', TOKEN],
  ['internal.js POST /api/internal/shots/:runId/note', TOKEN],
  ['internal.js POST /api/internal/shots/:runId/problem', TOKEN],
  ['internal.js POST /api/internal/shots/:runId/condition', TOKEN],
  ['internal.js POST /api/internal/sessions/:sessionId/visible-changes', TOKEN],
  ['internal.js POST /api/internal/sessions/:sessionId/diagram', TOKEN],
  // Homeroom bot parity, P8: a build's picture (worker/usernode-image).
  ['internal.js POST /api/internal/sessions/:sessionId/pictures', TOKEN],
  // Homeroom bot parity, P5: a running build reads the notes sent to it (worker/build-stop-hook.js).
  ['internal.js POST /api/internal/sessions/:sessionId/build-notes/take', TOKEN],
  ['internal.js POST /api/internal/sessions/:sessionId/push', 'retired callback: constant 410 response with no mutation or credential access'],
  ['internal.js POST /api/internal/sessions/:sessionId/pr', 'retired callback: constant 410 response with no mutation or credential access'],
  ['internal.js POST /api/internal/sessions/:sessionId/platform-issue', TOKEN],
  ['internal.js POST /api/internal/sessions/:sessionId/prod-debug/sql', TOKEN],
  ['issues.js POST /api/apps/:slug/issues', JSON_FIELD],
  ['issues.js POST /api/issues/:id/vote', JSON_FIELD],
  ['llm-grants.js POST /api/me/llm-grants', JSON_FIELD],
  ['mcp-remote.js POST /api/connect/oauth/register', TOKEN],
  ['mcp-remote.js POST /api/connect/oauth/token', TOKEN],
  ['mcp-remote.js POST /api/connect/oauth/revoke', TOKEN],
  ['mcp-remote.js POST /api/connect/oauth/authorize', OWN],
  ['moderation.js POST /api/reports', JSON_FIELD],
  ['moderation.js POST /api/conversations/:id/messages/:messageId/report', JSON_FIELD],
  ['moderation.js POST /api/apps/:slug/report', JSON_FIELD],
  ['moderation.js POST /api/apps/:slug/messages/:id/report', JSON_FIELD],
  ['onboarding.js POST /api/me/communities', JSON_FIELD],
  ['pm-order.js POST /api/apps/:slug/pm-order', JSON_FIELD],
  ['profile.js POST `/api/me/email/${action}`', JSON_FIELD],
  ['profile.js POST /api/me/username', JSON_FIELD],
  ['profile.js POST /api/me/username/choose', JSON_FIELD],
  ['profile.js POST /api/me/avatar', RAW],
  ['profiles.js POST /api/profiles/:username/report', JSON_FIELD],
  ['profiles.js POST /api/users/:username/report', JSON_FIELD],
  ['proposal-handoff.js POST /api/apps/:slug/proposals/:id/update-from-fork', JSON_FIELD],
  ['proposal-handoff.js POST /api/apps/:slug/work/share-in-progress', JSON_FIELD],
  ['proposal-handoff.js POST /api/apps/:slug/proposal-handoffs', JSON_FIELD],
  ['proposal-handoff.js POST /api/sessions/:id/proposal-handoff/context', JSON_FIELD],
  ['proposal-handoff.js POST /api/sessions/:id/proposal-handoff/commits', JSON_FIELD],
  ['proposal-handoff.js POST /api/sessions/:id/proposal-handoff/build', JSON_FIELD],
  ['public-api.js POST /api/public/waitlist', JSON_FIELD],
  ['public-api.js POST /api/public/waitlist/resend', JSON_FIELD],
  ['public-api.js POST /api/public/waitlist/status', JSON_FIELD],
  ['public-api.js POST /api/public/waitlist/confirm', JSON_FIELD],
  ['public-api.js POST /api/public/waitlist/more/:token', JSON_FIELD],
  ['report-snapshots.js POST /api/apps/:slug/report-snapshots', JSON_FIELD],
  ['request-specs.js POST /api/apps/:slug/issues/:number/spec', JSON_FIELD],
  ['sessions.js POST /api/sessions/:id/attachments', RAW],
  ['sessions.js POST /api/sessions/:id/chat', JSON_FIELD],
  ['sessions.js POST /api/sessions/:id/specs/:version/share-user', JSON_FIELD],
  ['social-identities.js POST /api/me/social-identities/:provider/replacement', OWN],
  ['social-identities.js POST /api/me/social-identities/x/check', OWN],
  ['topic-attributes.js POST /api/apps/:slug/topics/:targetType/:targetRef/attributes', JSON_FIELD],
  ['topochain/ingest.js POST /api/v4/slot-outcomes', TOKEN],
  ['topochain/ingest.js POST /api/v4/epoch-stats', TOKEN],
  ['topochain/mobile.js POST /challenges-api/terms/consent', JSON_FIELD],
  ['topochain/mobile.js POST /api/v4/mobile/zkpassport/complete', TOKEN],
  ['topochain/mobile.js POST /api/v4/mobile/wallet/claim', JSON_FIELD],
  ['topochain/native-session.js POST /api/v4/mobile/auth/restore-web-session', TOKEN],
  ['topochain/partner.js POST /api/v4/user-activities', TOKEN],
  ['topochain/public.js POST /api/v4/app-version/check', TOKEN],
  ['user-agent-files.js POST /api/me/agent-files', JSON_FIELD],
  ['votes.js POST /api/apps/:slug/pr-import', JSON_FIELD],
  ['votes.js POST /api/apps/:slug/pr-import/_mock/advance', JSON_FIELD],
  ['votes.js POST /api/sessions/:id/vote', JSON_FIELD],
  ['waitlist-connect.js POST /waitlist/connect/:provider/complete', JSON_FIELD],
  ['workshop-ask.js POST /api/apps/:slug/workshop/ask', JSON_FIELD],
  // #4313: the ?demo=1 Needs-you cards' vote, answered and never cast (staging only).
  ['workshop-overview.js POST /api/sessions/:id/vote', JSON_FIELD],
  // Declarations the literal-path scan used to miss.
  ['anthropic-proxy.js ALL `${ROUTE_PREFIX}*`', TOKEN],
  ['app-illustrations.js POST /api/apps/:slug/featured-illustration', RAW],
  ['cli-agent.js ALL /*', FILTER],
  ['cli-auth.js ALL /api/cli/device/approval', FILTER],
  ['cli-auth.js ALL /api/cli/device/approve', FILTER],
  ['cli-auth.js ALL /cli/authorize', FILTER],
  ['cli-auth.js ALL /api/cli/token/status', FILTER],
  ['cli-auth.js ALL /api/cli/token/current', FILTER],
  ["cli-auth.js USE '/api/cli/rpc/me'", FILTER],
  ['cli-auth.js ALL /api/cli/rpc/*', FILTER],
  ['cli-auth.js ALL /api/me/cli-tokens', FILTER],
  ['cli-auth.js ALL /api/me/cli-tokens/*', FILTER],
  ['cli-auth.js ALL /api/me/local-agents', FILTER],
  ['cli-auth.js ALL /api/me/local-agents/*', FILTER],
  ["explorer-proxy.js USE '/explorer-api'", TOKEN],
  ['mcp-remote.js POST MCP_PATH', TOKEN],
  ['mcp-remote.js ALL MCP_PATH', FILTER],
  ['moderation.js POST /api/profiles/:username/report', JSON_FIELD],
  ['moderation.js POST /api/users/:username/report', JSON_FIELD],
  ['topochain/epoch-delegation.js POST /api/v4/mobile/native/delegation', TOKEN],
  ["topochain/mobile.js USE '/challenges-api'", FILTER],
  ['topochain/native-session.js POST /api/v4/mobile/auth/native-establish-handoff', JSON_FIELD],
  ['topochain/native-session.js POST /api/v4/mobile/auth/native-establish-ticket', TOKEN],
  ['topochain/native-session.js POST /api/v4/mobile/auth/native-establish-exchange', TOKEN],
  ['topochain/native-session.js POST /api/v4/mobile/auth/logout', TOKEN],
]);

const ADMIN_PREFIX = /^\/api\/(v4\/)?admin(\/|$)/;

function routeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const UNSAFE = new Set(['post', 'put', 'patch', 'delete', 'all']);

// String paths a route argument names: a literal, an array of literals, or a
// const in the same file bound to either. null when it cannot be resolved.
function literalPaths(ts, node, consts) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((el) => literalPaths(ts, el, consts));
    return parts.every(Boolean) ? parts.flat() : null;
  }
  if (ts.isIdentifier(node) && consts.has(node.text)) return literalPaths(ts, consts.get(node.text), consts);
  return null;
}

// Parsed, not pattern-matched, so a declaration cannot hide in a form the
// scan does not know: every router.<verb>(…) call is found whatever its
// first argument, router.route(…).<verb> and router.all are reported, and a
// router.use whose inline handler answers requests itself (a terminal
// (req, res) handler, or one that looks at req.method) is reported too.
function unsafeRoutes() {
  const ts = require('typescript');
  const routesDir = path.join(ROOT, 'src/routes');
  const found = [];
  // child router factory -> the factory whose router mounts it (router.use).
  found.mounts = new Map();
  for (const file of routeFiles(routesDir).sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(routesDir, file).split(path.sep).join('/');
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const consts = new Map();
    const routers = new Set(['router']);
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (node.parent.flags & ts.NodeFlags.Const)) {
        consts.set(node.name.text, node.initializer);
      }
      // Any other name a Router() is bound to is a router too.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && ts.isCallExpression(node.initializer) && /\bRouter$/.test(node.initializer.expression.getText(sf))) {
        routers.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    const factoryOf = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
      }
      return null;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const verb = node.expression.name.text;
        const target = node.expression.expression;
        const onRouter = ts.isIdentifier(target) && routers.has(target.text);
        const onRoute = ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
          && target.expression.name.text === 'route';
        if (onRoute && UNSAFE.has(verb)) {
          found.push({ key: `${rel} ${verb.toUpperCase()} route(${target.arguments[0]?.getText(sf)})`, method: verb, paths: null, args: [] });
        } else if (onRouter && UNSAFE.has(verb) && node.arguments.length) {
          const [first, ...rest] = node.arguments;
          const paths = literalPaths(ts, first, consts);
          const args = rest.map((arg) => arg.getText(sf));
          const names = paths || [first.getText(sf)];
          const factory = factoryOf(node);
          for (const p of names) found.push({ key: `${rel} ${verb.toUpperCase()} ${p}`, method: verb, paths, route: p, args, file: rel, factory });
        } else if (onRouter && verb === 'use') {
          for (const arg of node.arguments) {
            if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
              found.mounts.set(arg.expression.text, factoryOf(node));
            }
          }
          const inline = node.arguments.filter((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
          const answers = inline.some((fn) => fn.parameters.length === 2 || /\breq\.method\b/.test(fn.body.getText(sf)));
          if (answers) {
            const first = node.arguments[0];
            const label = ts.isArrowFunction(first) || ts.isFunctionExpression(first) ? '*' : first.getText(sf).replace(/\s+/g, ' ');
            found.push({ key: `${rel} USE ${label}`, method: 'use', paths: null, args: [] });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test('every unsafe route is guarded, under the admin guard, or exempt with a reason', () => {
  const routes = unsafeRoutes();
  assert.ok(routes.length > 300, 'the inventory found the route files');
  const undecided = [];
  const seen = new Set();
  for (const { key, method, paths, route, args } of routes) {
    seen.add(key);
    const at = args.indexOf('sameOriginBrowserOnly');
    if (at >= 0) {
      assert.ok(!args.slice(at + 1).some((arg) => /Limiter/.test(arg)), `${key}: the guard follows its limiter`);
      assert.ok(!EXEMPT.has(key), `${key} is guarded, so it is not exempt`);
      continue;
    }
    // A preflighted verb on a path the scan could read needs no decision;
    // anything that also answers POST (all, use) or that it could not read does.
    if (paths && ADMIN_PREFIX.test(route)) continue;
    if (paths && ['put', 'patch', 'delete'].includes(method)) continue;
    if (!EXEMPT.has(key)) undecided.push(key);
  }
  assert.deepEqual(undecided, [], 'guard these routes or add them to EXEMPT with a reason');
  for (const key of EXEMPT.keys()) assert.ok(seen.has(key), `EXEMPT names a route that no longer exists: ${key}`);
});

test('admin writes are guarded as a block, ahead of every admin router', () => {
  const server = read('server.js');
  const mount = "app.use(['/api/admin', '/api/v4/admin'], require('./src/middleware/same-site-browser').sameOriginBrowserWrites);";
  const at = server.indexOf(mount);
  assert.ok(at > server.indexOf('app.use(authMiddleware(config));'), 'mounted after auth');
  // Every router factory that declares an admin write, found by the
  // inventory, reaches server.js through an app.use of its own or of the
  // router that mounts it; that app.use must come after the block guard.
  const routes = unsafeRoutes();
  const factories = new Map();
  for (const r of routes) {
    if (r.paths && ADMIN_PREFIX.test(r.route)) factories.set(r.factory, r.file);
  }
  assert.ok(factories.size >= 10, 'the inventory found the admin routers');
  const appUse = /^app\.use\((.*)$/gm;
  const mountsInServer = [...server.matchAll(appUse)].map((m) => ({ index: m.index, text: m[1] }));
  for (const [factory, file] of factories) {
    assert.ok(factory, `${file}: an admin route declared outside a named router factory`);
    let name = factory;
    const chain = [];
    let top = null;
    while (name && !top) {
      chain.push(name);
      top = mountsInServer.find((m) => new RegExp(`\\b${name}\\(`).test(m.text)) || null;
      if (!top) name = routes.mounts.get(name);
    }
    assert.ok(top, `${file}: ${chain.join(' <- ')} is not mounted by server.js`);
    assert.ok(at < top.index, `${file}: ${chain.join(' <- ')} is mounted before the admin block guard`);
  }
});

test('the admin block guard lets reads through and refuses cross-site writes', async () => {
  const { sameOriginBrowserWrites } = require('../src/middleware/same-site-browser');
  const app = express();
  app.use('/api/admin', sameOriginBrowserWrites);
  app.all('/api/admin/x', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/admin/x`;
    const headers = { 'sec-fetch-site': 'same-site' };
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
