'use strict';

const MAX_API_TARGET_BYTES = 2048;
const API_BASE = 'https://cli-api.invalid';
const DENIED_PREFIXES = Object.freeze([
  '/api/admin',
  '/api/app-llm',
  '/api/app-platform',
  '/api/app-storage',
  '/api/auth',
  '/api/cli',
  '/api/debug',
  '/api/iframe-token',
  '/api/internal',
  '/api/me/cli-tokens',
  '/api/node-status',
  '/api/v4',
]);
const DENIED_SEGMENTS = Object.freeze([
  'api-key',
  'credentials',
  'llm-grant',
  'llm-grants',
  'password',
  'secret-declaration-pr',
  'secrets',
  'wallet-change-password',
  'wallet-link',
]);
// Coding-agent model/preference routes are also credential-adjacent:
// a CLI bearer token must not set the default backend or list models
// under another user's key.
const DENIED_PREFIXES_EXTRA = Object.freeze([
  '/api/me/coding-agent',
]);
const SECRET_DECLARATION_BRANCH_PREFIX = 'secret-declare/';

function hasPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function canonicalApiTarget(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || !value.startsWith('/')
      || value.startsWith('//')
      || Buffer.byteLength(value, 'utf8') > MAX_API_TARGET_BYTES
      || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value, API_BASE);
  } catch {
    return null;
  }
  if (url.origin !== API_BASE
      || url.hash
      || !url.pathname.startsWith('/api/')
      || url.pathname.includes('%')) {
    return null;
  }
  const lowerPathname = url.pathname.toLowerCase();
  const segments = lowerPathname.split('/');
  if (DENIED_PREFIXES.some((prefix) => hasPrefix(lowerPathname, prefix))
      || DENIED_PREFIXES_EXTRA.some((prefix) => hasPrefix(lowerPathname, prefix))
      || segments.some((segment) => DENIED_SEGMENTS.includes(segment))) {
    return null;
  }
  return `${url.pathname}${url.search}`;
}

function isCliApiPath(pathname) {
  return canonicalApiTarget(pathname) === pathname;
}

// ── Hosted MCP connector policy ────────────────────────────────────────
//
// The CLI's `api:access` is a DENYLIST: everything under /api/ except the
// prefixes above. That is the right shape for a credential the user holds
// in a checkout they control, and the wrong shape for a token a third-party
// chat product (Claude.ai, ChatGPT) holds on their behalf.
//
// Connector tokens are therefore governed by an exhaustive ALLOWLIST,
// fail-closed: a route that is not listed here is refused, so adding a new
// platform endpoint can never silently widen what a connector can reach.
// Each entry is a method plus a path pattern where `:param` matches exactly
// one non-empty segment.
//
// Note what is NOT here and must not be added casually: nothing that votes,
// merges, force-merges, withdraws, changes app settings or touches
// membership. A connector may describe apps, file a request, hand work to
// the user's own coding agent and turn the result into a proposal — the
// group still decides whether it ships.
//
// The demo-mode entries at the end of the list are the one deliberate
// exception to that first sentence. The comment above them says exactly what
// makes them safe, and tests/mcp-connector-policy.test.js pins it.
const CONNECTOR_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps' },
  // #6026 — create_app: making a new project for the person who connected,
  // the one the Create screen makes. On the list because the route narrows a
  // connector token to exactly that (routes/apps.js, create-options.js
  // connectorCreateRefusal): a name, who it is for, its one line and what it
  // should do, and a private community unless it says otherwise. Invites,
  // imports, approval rules and starters are refused, so nobody else is
  // invited or told, no GitHub repository is touched, and membership changes
  // only by the creator's own row. The person's app allowance, the server's
  // app limit and the create rate limiter hold exactly as they do in the
  // browser. Delegated tokens keep their own lists, which do not carry it.
  { method: 'POST', pattern: '/api/apps' },
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  // A request's GitHub comments — the other half of its discussion, read by
  // prepare_work so a work order carries the requirements that landed in the
  // replies rather than only the opening line. Read-only, and the route
  // itself is already clipped and access-checked.
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  // Marking a request as being worked on, and handing it back (#1225). A
  // local coding agent has reached these two through the CLI's denylist
  // `api:access` since claims existed; a connector session — which is where
  // the agent that actually builds the thing increasingly lives — could not,
  // so its work was invisible on the board and two people could start the
  // same request without either seeing the other.
  //
  // On the list because a claim decides nothing: it is platform-local (no
  // GitHub write), it names only the CALLER (the route refuses a foreign
  // userId unless the caller is a write-admin), it expires on its own, and
  // clearing it is one call away. It is coordination data, not authority —
  // an issue holds many concurrent claims and holding one grants nothing.
  // release_request never sends the `userId` body the DELETE route accepts
  // from a write-admin, so a connector only ever clears its own claim.
  { method: 'POST', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'DELETE', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/issues' },
  // create_request's screenshots: one image upload, the same route the
  // feedback dialog uses. On the list because an upload decides nothing: it
  // stores one sniffed PNG or JPEG of at most 4 MB owned by the caller, under
  // the per-user upload limiter, and a row no request ever links is deleted
  // after 24 hours. Only the issues route above can put it on the board, and
  // only for the caller who uploaded it.
  { method: 'POST', pattern: '/api/feedback/screenshot' },
  // A project's card picture (routes/app-illustrations.js):
  // get_featured_illustration and propose_featured_illustration. The read and
  // the editor's own PUT, behind the route's gate, which admits only people
  // who may manage the app (its creator, its admins, full platform admins).
  // The PUT decides nothing either: it opens the group's vote on the new
  // picture, and the card changes only when the vote passes. The route's
  // POST, PATCH and DELETE stay off the list: the tool needs none of them.
  { method: 'GET', pattern: '/api/apps/:slug/featured-illustration' },
  { method: 'PUT', pattern: '/api/apps/:slug/featured-illustration' },
  // Specs on a request (routes/request-specs.js): post_spec, get_spec and
  // get_request. A post decides nothing either: it stores the caller's own
  // plan on the caller's own planning record, behind the same membership and
  // collaborator gates as filing the request, for the group to read and
  // discuss; nothing is built or voted on by it. The version read is the spec
  // card's own route, which serves only what is shared or the caller's own.
  { method: 'POST', pattern: '/api/apps/:slug/issues/:number/spec' },
  { method: 'GET', pattern: '/api/apps/:slug/issues/:number/specs' },
  { method: 'GET', pattern: '/api/sessions/:id/specs/:version' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
  { method: 'GET', pattern: '/api/sessions/:id/spec' },
  // Post-creation issue association (#2028). The route is owner-scoped for
  // connectors, accepts only bounded issue-number deltas, and changes no code
  // or vote. The tool uses the browser's same doorway instead of gaining a
  // parallel metadata writer.
  { method: 'PATCH', pattern: '/api/sessions/:id/linked-issues' },
  { method: 'GET', pattern: '/api/sessions/:id/description' },
  { method: 'PATCH', pattern: '/api/sessions/:id/description' },
  { method: 'GET', pattern: '/api/me/active-sessions' },
  // The proposal pipeline: submit_work turns a pushed branch into an
  // ordinary imported proposal, and the platform-build fallback runs an
  // unattended build and promotes its clone.
  { method: 'GET', pattern: '/api/apps/:slug/pr-import/preview' },
  { method: 'POST', pattern: '/api/apps/:slug/pr-import' },
  // Advancing a proposal that is already up for a vote (#1054), from a branch
  // in the author's own fork. Allowlisted because the connector is where the
  // agent that wrote the code lives — a failing check gates merge, and until
  // this route existed the cheapest possible fixer of its own failing test had
  // no way to land the fix. The route itself refuses everything that is not
  // the caller's own open proposal.
  { method: 'POST', pattern: '/api/apps/:slug/proposals/:id/update-from-fork' },
  // Before/after shot diagnostics are read-only and the handler requires the
  // proposal owner or an app manager. A connector needs this exact route to
  // see why shots were skipped or failed without infrastructure credentials.
  { method: 'GET', pattern: '/api/apps/:slug/proposals/:id/shots/diagnostics' },
  // Sharing work to the IN-PROGRESS area instead of putting it to a vote
  // (#1347). Allowlisted for the same reason as the route above: the agent
  // that wrote the code lives in the connector, and until this existed its
  // only destination was a group vote — so work still moving had to be either
  // invisible or prematurely up for review. The route creates a session owned
  // by the caller and hands it to the same fork-attribution gate every other
  // hand-off goes through; it can write nothing that is not the caller's own.
  { method: 'POST', pattern: '/api/apps/:slug/work/share-in-progress' },
  { method: 'POST', pattern: '/api/apps/:slug/issues/:number/headless-session' },
  { method: 'POST', pattern: '/api/sessions/:id/clone-headless' },
  { method: 'POST', pattern: '/api/sessions/:id/promote' },
  // submit_work's `propose: true` reopens a paused session before promoting
  // it — an external update usually lands on a paused one. Owner-scoped like
  // promote: the handler's probe and its resuming UPDATE both match
  // (id, user_id), so a connector can only ever reopen the caller's own
  // session (see the owner-scope tests beside promote's).
  { method: 'POST', pattern: '/api/sessions/:id/resume' },
  // recheck_change (#2779): re-run the checks on a proposal's CURRENT commit.
  // No code moves and no vote is touched — it is the same act as the "Re-run
  // checks" button, and submit_work's `recheck: true` already reaches it
  // through the update route. The handler refuses anyone but the owner or a
  // write-admin, and a proposal that is no longer open.
  { method: 'POST', pattern: '/api/sessions/:id/recheck' },
  // Demo mode (routes/demo-mode.js): the one deliberate exception to the
  // note above, so it is worth being exact. These five let a connected agent
  // drive a RECORDING of the proposal flow: a synthetic partner proposes,
  // votes, and is reset between takes. Two of them do what nothing else on
  // this list does — demo/vote casts a vote and demo/reset moves an app's
  // main — and the reason they may is entirely the handler's gate, which the
  // policy tests pin: every one of these routes refuses unless the app is in
  // demo mode AND the caller is its creator AND a full platform admin (both
  // fences — never an admin's override on somebody else's app), and the
  // platform's own app can never be in demo mode. Through them a connector
  // reaches only an app its user owns and has switched into a mode whose
  // settings say a synthetic partner is acting on it. The general vote
  // route (/api/sessions/:id/vote) stays off this list, as it always has.
  { method: 'POST', pattern: '/api/apps/:slug/demo-mode' },
  { method: 'GET', pattern: '/api/apps/:slug/demo' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/propose' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/promote' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/vote' },
  { method: 'POST', pattern: '/api/apps/:slug/demo/reset' },
  // #3654: grading the Homeroom bot's benchmark, by an admin's own Claude
  // session through the connector (services/bench/grading.js). The second
  // deliberate exception to the note above, for the opposite reason to demo
  // mode's: these change nothing in any app, but they READ tasks from every
  // app, private ones included. What earns them their place is the handler's
  // gate, which the policy tests pin: every one refuses anybody who is not a
  // full platform admin (requireAdminWrite) before it reads anything. They
  // live outside /api/admin only because a connector can never reach that
  // prefix, and they write nothing but a grade or a label.
  { method: 'GET', pattern: '/api/bot-bench/queue' },
  { method: 'GET', pattern: '/api/bot-bench/items/:token' },
  { method: 'POST', pattern: '/api/bot-bench/items/:token/grade' },
  { method: 'POST', pattern: '/api/bot-bench/tasks/:token/label' },
  // #3654: running the benchmark from the same admin's session. The same
  // gate, first on every handler (requireAdminWrite); the read is a run's
  // aggregates only, never a trial; the three writes launch a run within a
  // cap the caller must name, cancel one, or grade a finished one again
  // (no model runs), and touch no app.
  { method: 'GET', pattern: '/api/bot-bench/runs' },
  { method: 'GET', pattern: '/api/bot-bench/runs/:id' },
  { method: 'POST', pattern: '/api/bot-bench/runs' },
  { method: 'POST', pattern: '/api/bot-bench/runs/:id/cancel' },
  { method: 'POST', pattern: '/api/bot-bench/runs/:id/regrade' },
  // The App bench studio, and the rest of the benchmark and the bot's own
  // data for the same admin's session (routes/bench-studio.js). The same gate
  // first on every handler (requireAdminWrite), reads included: they read
  // tasks, builds, previews and screenshots of every app, private ones too.
  // Every write is then limited per person and refused to a browser on
  // another origin; a launch must name its cap. They change no app: they
  // launch, steer and preview benchmark builds on the studio's own private
  // host app, save context packs, add or edit benchmark tasks, rate a bot
  // run, and save the bot's settings as the console's Save does (they decide
  // what it does on every app, so the tool asks the person first).
  { method: 'GET', pattern: '/api/bot-studio' },
  { method: 'GET', pattern: '/api/bot-studio/gallery' },
  { method: 'GET', pattern: '/api/bot-studio/runs/:id/watch' },
  { method: 'GET', pattern: '/api/bot-studio/runs/:id/reference-order' },
  { method: 'POST', pattern: '/api/bot-studio/launch' },
  { method: 'POST', pattern: '/api/bot-studio/runs/:id/references' },
  { method: 'POST', pattern: '/api/bot-studio/trials/:id/rerun' },
  { method: 'POST', pattern: '/api/bot-studio/trials/:id/cancel' },
  { method: 'POST', pattern: '/api/bot-studio/trials/:id/keep' },
  { method: 'POST', pattern: '/api/bot-studio/trials/:id/preview' },
  { method: 'GET', pattern: '/api/bot-studio/packs' },
  { method: 'GET', pattern: '/api/bot-studio/packs/:id' },
  { method: 'POST', pattern: '/api/bot-studio/packs' },
  { method: 'GET', pattern: '/api/bot-studio/suites' },
  { method: 'GET', pattern: '/api/bot-studio/suites/:id' },
  { method: 'POST', pattern: '/api/bot-studio/suites/:id/tasks' },
  { method: 'POST', pattern: '/api/bot-studio/tasks/:id/taste' },
  { method: 'GET', pattern: '/api/bot-studio/runs/:id/trials' },
  { method: 'GET', pattern: '/api/bot-studio/trials/:id' },
  { method: 'GET', pattern: '/api/bot-studio/trials/:id/transcript' },
  { method: 'GET', pattern: '/api/bot-studio/bot' },
  { method: 'POST', pattern: '/api/bot-studio/bot/runs/:id/rating' },
  { method: 'POST', pattern: '/api/bot-studio/bot/settings' },
  { method: 'GET', pattern: '/api/bot-studio/shots' },
  { method: 'GET', pattern: '/api/bot-studio/shots/:id' },
  // The Homeroom bot's configurations, first versions' and later changes'
  // (routes/bot-configs.js): the same gate first on every handler, reads
  // included (a pair shows screenshots of any app, private ones too); every
  // write limited per person and refused to a browser on another origin.
  // They change no app: they save a configuration version, set its role, set
  // a scope's side-build budget, and record a pick.
  { method: 'GET', pattern: '/api/bot-configs' },
  { method: 'POST', pattern: '/api/bot-configs' },
  { method: 'POST', pattern: '/api/bot-configs/:id/role' },
  { method: 'POST', pattern: '/api/bot-configs/budget' },
  { method: 'GET', pattern: '/api/bot-configs/pairs/next' },
  { method: 'POST', pattern: '/api/bot-configs/pairs/:token/pick' },
  // Before & after shots evals (routes/shots-evals.js): the same gate first on
  // every handler, reads included (an eval shows screenshots of any app,
  // private ones too); every write limited per person and refused to a
  // browser on another origin; a launch must name its cap. They change no
  // app and no proposal: they save a shots configuration, launch or cancel
  // an eval of merged proposals, and record a pick.
  { method: 'GET', pattern: '/api/shots-evals' },
  { method: 'POST', pattern: '/api/shots-evals' },
  { method: 'GET', pattern: '/api/shots-evals/configs' },
  { method: 'POST', pattern: '/api/shots-evals/configs' },
  { method: 'GET', pattern: '/api/shots-evals/pairs/next' },
  { method: 'POST', pattern: '/api/shots-evals/pairs/:token/pick' },
  { method: 'GET', pattern: '/api/shots-evals/:id' },
  { method: 'GET', pattern: '/api/shots-evals/:id/shots' },
  { method: 'POST', pattern: '/api/shots-evals/:id/cancel' },
  // Test accounts for first-run testing (routes/test-accounts.js). The third
  // deliberate exception: these make, list and retire ACCOUNTS — a new
  // sign-in, handed back once to the admin who asked. They may because of the
  // gate every handler puts first, which the policy tests pin:
  // requireAdminWrite (a full platform admin, never a view-only one), then a
  // per-admin limiter, then the same-origin browser guard. What they make is
  // fenced from every real outcome (services/test-accounts.js), at most 25
  // are live at once, and retiring one takes only accounts flagged as test
  // accounts, with the apps they made. Outside /api/admin and /api/auth only
  // because a connector can reach neither, and with no `password` segment,
  // which the canonical-target wall refuses anyway.
  { method: 'POST', pattern: '/api/test-accounts' },
  { method: 'GET', pattern: '/api/test-accounts' },
  { method: 'POST', pattern: '/api/test-accounts/:id/retire' },
  // A one-time phone sign-in for a test number, the same gate: what it signs
  // in to is a test account (services/test-accounts.js mintPhoneSignIn).
  { method: 'POST', pattern: '/api/test-accounts/phone-sign-ins' },
  // The waitlist's "you're in" mail sent to a test address, the same gate:
  // the account its link makes is a test account (services/test-accounts.js
  // sendRelease), and the mail goes through the ordinary throttle.
  { method: 'POST', pattern: '/api/test-accounts/release-emails' },
  // A test project's run report, the same gate: a read of what was recorded
  // about its first version, or the copy retiring the account kept
  // (services/run-report.js). Metadata and short excerpts, never a secret.
  { method: 'GET', pattern: '/api/test-accounts/run-report' },
  // One notification of every kind to a test account, the same gate: the
  // rows are fake, so only an account flagged as a test account takes them
  // (services/test-notifications.js).
  { method: 'POST', pattern: '/api/test-accounts/:id/notifications' },
  // The programme's challenges (routes/challenge-admin.js): the events, the
  // challenges in each, the templates they are stamped from and the rules
  // that score them, as the console's Season events, Challenge templates and
  // Challenge scoring screens manage them. The same gate first on every
  // handler (requireAdminWrite), reads included; every write then limited per
  // person and refused to a browser on another origin. Each one hands on to
  // the console's own /api/v4/admin route, which a connector can never reach
  // directly, and only these: deleting a whole event stays in the console.
  // They change the programme people see on Challenges, never an app.
  { method: 'GET', pattern: '/api/challenge-admin/season-events' },
  { method: 'POST', pattern: '/api/challenge-admin/season-events' },
  { method: 'GET', pattern: '/api/challenge-admin/season-events/:id' },
  { method: 'PATCH', pattern: '/api/challenge-admin/season-events/:id' },
  { method: 'GET', pattern: '/api/challenge-admin/season-events/:id/challenges' },
  { method: 'POST', pattern: '/api/challenge-admin/season-events/:id/challenges' },
  { method: 'GET', pattern: '/api/challenge-admin/season-events/:id/challenges/available-activity-types' },
  { method: 'PATCH', pattern: '/api/challenge-admin/season-events/:id/challenges/update-display-orders' },
  { method: 'PUT', pattern: '/api/challenge-admin/season-events/:id/challenges/:challenge' },
  { method: 'DELETE', pattern: '/api/challenge-admin/season-events/:id/challenges/:challenge' },
  { method: 'PATCH', pattern: '/api/challenge-admin/season-events/:id/challenges/:challenge/move' },
  { method: 'GET', pattern: '/api/challenge-admin/challenge-templates' },
  { method: 'POST', pattern: '/api/challenge-admin/challenge-templates' },
  { method: 'GET', pattern: '/api/challenge-admin/challenge-templates/:id' },
  { method: 'PATCH', pattern: '/api/challenge-admin/challenge-templates/:id' },
  { method: 'DELETE', pattern: '/api/challenge-admin/challenge-templates/:id' },
  { method: 'GET', pattern: '/api/challenge-admin/challenge-scoring' },
  { method: 'POST', pattern: '/api/challenge-admin/challenge-scoring/rules' },
  { method: 'PUT', pattern: '/api/challenge-admin/challenge-scoring/rules/:id' },
  { method: 'DELETE', pattern: '/api/challenge-admin/challenge-scoring/rules/:id' },
  { method: 'POST', pattern: '/api/challenge-admin/challenge-scoring/run' },
  // Featured apps (routes/featured-admin.js): the list the signed-out
  // landing's Featured and every user's "Find more apps" row read, and the
  // flag that takes an app out of Discover and Featured, as Admin > Featured
  // apps manages them. The same gate first on every handler
  // (requireAdminWrite), the read included; every write then limited per
  // person and refused to a browser on another origin. Each one hands on to
  // the console's own /api/admin route (routes/admin-featured-apps.js), which
  // a connector can never reach directly. They change what people see on the
  // landing and Home, never an app.
  { method: 'GET', pattern: '/api/featured-admin/featured-apps' },
  { method: 'PUT', pattern: '/api/featured-admin/featured-apps' },
  { method: 'PUT', pattern: '/api/featured-admin/apps/:slug/discover-flag' },
  // The browser languages people use, and where the translation step stands
  // (routes/ui-telemetry.js): a read, behind the same full-admin gate.
  { method: 'GET', pattern: '/api/browser-languages' },
]);

// ── Delegated grants (#2779) ───────────────────────────────────────────
//
// A delegated token is the platform's OWN agent acting for the user, and each
// kind gets its own exhaustive list — never the external list above, and
// never the CLI denylist. The same fail-closed rule holds: a route not named
// for that kind is refused, whatever the token's scopes say.
//
// `agent_mayor` — the Mayor of an agent session. Every read its tools make,
// the request writes the external list already carries, and the change
// lifecycle of the user's own native changes: create, promote, resume,
// re-check, sync with main, withdraw. What is here and NOT on the external
// list is exactly the three routes the classic dev chat's own buttons call,
// each owner-scoped by its handler; and every write a Mayor makes is one the
// user confirmed first (the token for it is minted at that moment and lives
// for one action). Still nothing that votes, merges, touches settings,
// secrets or membership.
const AGENT_MAYOR_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps' },
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  { method: 'POST', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'DELETE', pattern: '/api/apps/:slug/github-issues/:number/claim' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/messages' },
  { method: 'POST', pattern: '/api/apps/:slug/issues' },
  { method: 'GET', pattern: '/api/me/active-sessions' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
  { method: 'GET', pattern: '/api/sessions/:id/spec' },
  { method: 'PATCH', pattern: '/api/sessions/:id/linked-issues' },
  // The change lifecycle (start_change, promote_change, recheck_change,
  // sync_change, withdraw_change). start_change names the change on the
  // create itself, so the rename route is not on this list.
  { method: 'POST', pattern: '/api/apps/:slug/sessions' },
  { method: 'POST', pattern: '/api/sessions/:id/promote' },
  { method: 'POST', pattern: '/api/sessions/:id/resume' },
  { method: 'POST', pattern: '/api/sessions/:id/recheck' },
  { method: 'POST', pattern: '/api/sessions/:id/sync-main' },
  { method: 'POST', pattern: '/api/sessions/:id/archive' },
]);

// `worker_read` — the coding agent inside one change's worker. It runs the
// repository's own code with a shell, so assume it can read its token: GETs
// only, and only what its six read tools need. The bearer chain additionally
// pins every `:slug` to the grant's app and every `:id` to a change in that
// app (see delegatedRouteBinding), so the worst a leaked token does is read
// one app the user can already see.
const WORKER_READ_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/apps/:slug' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues' },
  { method: 'GET', pattern: '/api/apps/:slug/github-issues/:number/comments' },
  { method: 'GET', pattern: '/api/apps/:slug/promoted' },
  { method: 'GET', pattern: '/api/sessions/:id' },
  { method: 'GET', pattern: '/api/sessions/:id/status' },
]);

// `bot_admin`: Homeroom bot answering a full platform admin in their own
// conversation with it (Homeroom bot parity P7): exactly the routes its
// curated tools call (services/mcp-audiences.js BOT_ADMIN_TOOLS), each one
// already on the external list above and gated by its own handler for a full
// admin (the featured picture: for whoever may manage the project). Its
// writes run only on a grant minted for one action the admin confirmed on a
// card.
const BOT_ADMIN_ALLOWED_ROUTES = Object.freeze([
  { method: 'GET', pattern: '/api/bot-bench/runs' },
  { method: 'GET', pattern: '/api/bot-bench/runs/:id' },
  { method: 'POST', pattern: '/api/bot-bench/runs' },
  { method: 'GET', pattern: '/api/bot-configs' },
  { method: 'POST', pattern: '/api/bot-configs' },
  { method: 'POST', pattern: '/api/bot-configs/:id/role' },
  { method: 'POST', pattern: '/api/bot-configs/budget' },
  { method: 'GET', pattern: '/api/test-accounts' },
  { method: 'POST', pattern: '/api/test-accounts' },
  { method: 'POST', pattern: '/api/test-accounts/:id/retire' },
  { method: 'POST', pattern: '/api/test-accounts/release-emails' },
  { method: 'GET', pattern: '/api/apps/:slug/featured-illustration' },
  { method: 'PUT', pattern: '/api/apps/:slug/featured-illustration' },
  { method: 'GET', pattern: '/api/bot-studio/bot' },
  { method: 'POST', pattern: '/api/bot-studio/bot/settings' },
  { method: 'GET', pattern: '/api/bot-studio/shots' },
]);

const DELEGATED_ALLOWED_ROUTES = Object.freeze({
  agent_mayor: AGENT_MAYOR_ALLOWED_ROUTES,
  worker_read: WORKER_READ_ALLOWED_ROUTES,
  bot_admin: BOT_ADMIN_ALLOWED_ROUTES,
});

function matchesPattern(pathname, pattern) {
  const actual = pathname.split('/');
  const expected = pattern.split('/');
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) {
      if (!actual[i]) return false;
      continue;
    }
    if (expected[i] !== actual[i]) return false;
  }
  return true;
}

// A connector token may reach exactly the (method, path) pairs above — and
// only after the shared canonical-target check, so the denied prefixes and
// credential segments still apply as a second, independent wall.
function isConnectorApiRequest(method, pathname) {
  if (typeof method !== 'string' || typeof pathname !== 'string') return false;
  if (canonicalApiTarget(pathname) !== pathname) return false;
  const upper = method.toUpperCase();
  return CONNECTOR_ALLOWED_ROUTES.some(
    (route) => route.method === upper && matchesPattern(pathname, route.pattern)
  );
}

// The delegated twin of isConnectorApiRequest: the same canonical-target
// wall underneath, then the kind's own list. An unknown kind reaches nothing.
function isDelegatedApiRequest(kind, method, pathname) {
  const routes = Object.prototype.hasOwnProperty.call(DELEGATED_ALLOWED_ROUTES, kind)
    ? DELEGATED_ALLOWED_ROUTES[kind] : null;
  if (!routes || typeof method !== 'string' || typeof pathname !== 'string') return false;
  if (canonicalApiTarget(pathname) !== pathname) return false;
  const upper = method.toUpperCase();
  return routes.some((route) => route.method === upper && matchesPattern(pathname, route.pattern));
}

// The app and change a delegated request names, read off the matched route
// pattern so the bearer chain can hold a bound grant to them. `slug` is the
// `:slug` segment and `sessionId` the numeric `:id` segment; null when the
// route has neither. A non-numeric `:id` is reported as NaN, which no change
// matches.
function delegatedRouteBinding(kind, method, pathname) {
  const routes = DELEGATED_ALLOWED_ROUTES[kind] || [];
  const upper = String(method || '').toUpperCase();
  const route = routes.find((r) => r.method === upper && matchesPattern(pathname, r.pattern));
  if (!route) return null;
  const actual = pathname.split('/');
  const expected = route.pattern.split('/');
  const binding = { slug: null, sessionId: null };
  expected.forEach((segment, i) => {
    if (segment === ':slug') binding.slug = actual[i];
    if (segment === ':id') binding.sessionId = /^[1-9]\d{0,9}$/.test(actual[i]) ? Number(actual[i]) : NaN;
  });
  return binding;
}

// Secret-declaration proposals use otherwise-generic session endpoints for
// voting, force-merging, withdrawal, and restoration. Those endpoints cannot
// be denied by pathname without also disabling ordinary PR workflows, so the
// route handlers use this immutable platform branch marker after loading the
// session. Browser requests are deliberately unaffected.
function isCliCredentialManagementSession(req, session) {
  return !!req?.cliAuthenticated
    && typeof session?.branch_name === 'string'
    && session.branch_name.startsWith(SECRET_DECLARATION_BRANCH_PREFIX);
}

module.exports = {
  MAX_API_TARGET_BYTES,
  DENIED_PREFIXES,
  DENIED_SEGMENTS,
  SECRET_DECLARATION_BRANCH_PREFIX,
  CONNECTOR_ALLOWED_ROUTES,
  AGENT_MAYOR_ALLOWED_ROUTES,
  WORKER_READ_ALLOWED_ROUTES,
  BOT_ADMIN_ALLOWED_ROUTES,
  canonicalApiTarget,
  isCliApiPath,
  isConnectorApiRequest,
  isDelegatedApiRequest,
  delegatedRouteBinding,
  isCliCredentialManagementSession,
};
