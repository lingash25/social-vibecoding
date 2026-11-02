'use strict';

// Hosted MCP connector — shared constants.
//
// Sibling of services/cli-auth-constants.js, deliberately separate: the CLI
// flow is a first-party device-code grant with a pinned client identity and
// its own two scopes, while this is an OAuth 2.1 authorization-code + PKCE
// server for THIRD-PARTY chat products (Claude.ai, ChatGPT). Sharing the
// constants would end with one flow's tightening silently loosening the
// other.

// Narrow, connector-specific scopes. NOT the CLI's `api:access`, which is a
// denylist over nearly the whole API — right for a checkout the user
// controls, wrong for a third-party web product.
const READ_SCOPE = 'usernode:apps:read';
const WRITE_SCOPE = 'usernode:proposals:write';
const SUPPORTED_SCOPES = Object.freeze([READ_SCOPE, WRITE_SCOPE]);

// Opaque bearer prefix, distinct from the CLI's `svcli_` so the shared
// bearer entry point can route a token to the right table by shape alone.
const TOKEN_PREFIX = 'svmcp_';
const REFRESH_PREFIX = 'svmcr_';

// Delegated access tokens (#2779): the platform's own agents acting for a
// user, never a client the user connected. A prefix of their own lets the
// staging and enablement gates recognise one by shape before any lookup —
// the one kind of connector credential those gates let through — and lets a
// worker's output scrubber find one without knowing its value. Shape is
// routing only: the token is still honoured only if its grant joins a live
// mcp_delegations row.
const DELEGATED_TOKEN_PREFIX = 'svmcd_';

// Who a delegated grant is for. `agent_mayor` is the Mayor of an agent
// session; `worker_read` is the coding agent inside one change's worker;
// `bot_admin` is Homeroom bot answering a full platform admin in their own
// conversation with it, reaching the connector's admin tools (Homeroom bot
// parity P7, homeroom-bot-thread-tools/admin.js). The server picks the kind
// when it issues the grant; nothing a client sends can name one.
const DELEGATION_KINDS = Object.freeze(['agent_mayor', 'worker_read', 'bot_admin']);

// The synthetic client id each kind's tokens carry. Deliberately NOT the
// `svmc_…` shape CLIENT_ID_RE accepts, so loadClient refuses them and the
// consent and token endpoints can never mint, refresh or approve anything
// under one.
const DELEGATED_CLIENT_IDS = Object.freeze({
  agent_mayor: 'homeroom:agent_mayor',
  worker_read: 'homeroom:worker_read',
  bot_admin: 'homeroom:bot_admin',
});

// Shown where a connector's name is (whoami's `connectedFrom`, logs).
const DELEGATED_CLIENT_NAMES = Object.freeze({
  agent_mayor: 'Homeroom agent session',
  worker_read: 'Homeroom coding agent',
  bot_admin: 'Homeroom bot (admin tools)',
});

// Upper bounds on a delegated grant's life. A Mayor's read token lasts one
// turn and a write token one confirmed action; a worker's lasts one build
// turn. The caller asks for less and revokes in its `finally`; these are the
// ceilings for a caller that forgets.
const DELEGATION_MAX_TTL_SECONDS = Object.freeze({
  agent_mayor: 15 * 60,
  worker_read: 2 * 60 * 60,
  // One read in a turn, or one confirmed write.
  bot_admin: 5 * 60,
});

const AUTH_CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// The MCP endpoint and its browser-facing consent page.
const MCP_PATH = '/mcp';
const CONSENT_PATH = '/connect/authorize';

// Hosts whose https redirect URIs dynamic client registration will accept.
// Registration is allowlisted rather than open: the platform is not trying
// to be a general-purpose OAuth provider, and the consent screen's only
// real defence against a lookalike client is showing a redirect origin the
// user recognises.
const DEFAULT_REDIRECT_HOSTS = Object.freeze([
  'claude.ai',
  'claude.com',
  'chatgpt.com',
  'openai.com',
]);

// Per-token and per-IP request budgets at the /mcp edge.
const TOKEN_RATE_PER_MINUTE = 60;
const IP_RATE_PER_MINUTE = 300;
// Dynamic client registration is cheap to call and creates rows, so it
// gets its own much tighter per-IP bucket.
const REGISTER_RATE_PER_MINUTE = 6;

// ── The connector's canonical name ─────────────────────────────────────
//
// SERVER_NAME is what this server reports as `serverInfo.name` in the MCP
// initialize response, and it is the CANONICAL spelling of the connector
// everywhere: docs, allow rules, the scaffolded `.claude/settings.json`.
//
// #1218: an account had the connector registered as `Uesrnode`, so its
// tools arrived as `mcp__Uesrnode__whoami`. That string is NOT ours — it
// never appears in this repository. Claude.ai's "Add custom connector"
// dialog takes a Name the human types, and the client builds tool names
// from THAT, not from `serverInfo.name`. So the typo was user-entered, and
// the fix is to recommend the canonical name at connect time (the
// Settings → Connectors copy does) rather than to change anything here.
//
// Why lowercase: a client that derives the name from the server gets
// exactly this string, so a client where the user typed it agrees with a
// client where it did not. Any other spelling makes the two paths
// disagree — which is the whole reason the value below is stated once,
// here, and read by the docs, the scaffold and the Settings copy rather
// than retyped in each.
//
// It matters because a Claude Code permission rule names the server as a
// LITERAL: `mcp__homeroom__get_*` is legal, `mcp__*__get_*` is not. A rule
// aimed at a differently-named connector fails SILENTLY — no error, the
// user just keeps getting prompted. Hence: recommend the name, and tell
// people to read it off their own tool list (see MCP-CONNECTOR.md).
//
// ── Why this says `homeroom` and not `usernode` ────────────────────────
//
// The platform is reached at Homeroom's own domain now, and that is the
// name people are told to type when they add the connector. Leaving the
// server reporting `usernode` would break the agreement above in the one
// way it exists to prevent: the docs would say type one thing while
// `serverInfo.name` reported another, so a client that derives the name
// and a client where a human typed it would disagree by construction.
//
// The rename is NOT retroactive, and cannot be. A connector already added
// as `usernode` keeps that name — the client built its tool names from
// what its user typed, and nothing the server reports changes them — so
// existing rules go on matching. What does move is a client that derives
// the name: on its next reconnect its tools become `mcp__homeroom__…` and
// rules written for the old spelling stop matching, silently, exactly as
// above. That is what keeps both legacy spellings in
// ALLOW_RULE_SERVER_NAMES below: the shipped list has to cover the name a
// user is on today as well as the one they will be on tomorrow.
const SERVER_NAME = 'homeroom';

// ── The build the handshake reports ────────────────────────────────────
//
// SERVER_VERSION is `serverInfo.version` in the initialize response — the
// one field in the handshake whose purpose is to say WHICH server answered.
// As a frozen literal it said nothing: three handshakes spanning a deploy
// boundary all reported `1.0.0`, and establishing which build was actually
// live meant reading a client debug log for the truncated-instructions
// length and matching it against SERVER_INSTRUCTIONS at two commits — a
// trick that only worked because that length happened to change between
// them. A deploy that changes behaviour without changing it leaves no
// signal at all.
//
// It matters because MCP splits what a client learns in two: `instructions`,
// tool names and tool descriptions are fetched ONCE at initialize and cached
// for the life of the connection, while tool results are live. A session's
// cached rules can therefore come from an older build than the code now
// answering its calls, and this is the only field that can tell them apart.
// get_connector_guidance sharpens it further — the operating charter a
// connector agent follows now depends on which build served its handshake.
//
// GIT_SHA is the platform's own build stamp, already plumbed through
// docker-compose.yml and read exactly this way by /api/version,
// services/status and services/node-status. Reusing it keeps ONE answer to
// "what is running" instead of minting a second one that can disagree.
//
// `serverInfo.version` is free-form in MCP, so the commit rides along as
// semver build metadata: the string stays parseable, and a build with no
// deploy behind it still reads honestly instead of claiming to be a release
// (staging previews of the platform are built without GIT_SHA, and compose
// defaults it to `dev` — so `1.0.0+dev` says "not a deployed build" where a
// bare `1.0.0` would have said nothing). whoami returns the same string, so
// a session can read it without going through a client debug log.
//
// TWO THINGS MUST NOT MOVE WITH IT. SERVER_NAME stays fixed, because allow
// rules match it as a LITERAL (see above) and a per-deploy name would break
// every rule the platform ships, silently. And the build id stays OUT of
// SERVER_INSTRUCTIONS, which is budgeted to the byte against a client that
// truncates it (SERVER_INSTRUCTIONS_MAX_CHARS): serverInfo and a tool result
// both sit outside that budget, which is precisely why they are the two
// right places to carry it.
const SERVER_VERSION_BASE = '1.0.0';

// Semver build metadata is [0-9A-Za-z-], and GIT_SHA arrives from the
// environment rather than from this repository, so it is narrowed rather
// than trusted. A value that narrows away to nothing leaves the bare base
// version instead of a dangling `+`.
function serverVersionFor(gitSha) {
  const build = String(gitSha == null ? '' : gitSha)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 7);
  return build ? `${SERVER_VERSION_BASE}+${build}` : SERVER_VERSION_BASE;
}

const SERVER_VERSION = serverVersionFor(process.env.GIT_SHA);

// ── The spellings the shipped rules cover ──────────────────────────────
//
// A permission rule names its server LITERALLY, so a rule is only ever as
// good as the spelling in it. The canonical name is what this server reports
// and what Settings → Connectors tells the user to type — but the field it is
// typed into is a free-text box in someone else's dialog, and the single most
// likely near-miss is not a typo at all: it is the product name capitalised,
// which is how a person naturally writes it and what several clients suggest
// as a default.
//
// So the shipped rules cover BOTH spellings rather than only the canonical
// one. Twice the rules for a name, which costs nothing — a rule that matches
// no tool is inert — and removes the most common silent failure. Anything
// beyond these still needs the user's own spelling, which is what the setup
// tip, whoami and the Settings panel's rewrite field are all for: this list
// is the spellings worth guessing, not an attempt to guess them all.
//
// ── Why the list carries two names and not one ─────────────────────────
//
// `homeroom` and `Homeroom` are the guess pair for the name people are told
// to type today. `usernode` and `Usernode` are not guesses at all: they are
// the name the connector was called before the rename, so they are what an
// account connected before it is REGISTERED AS, and a rule aimed at the new
// spelling would miss every one of them. Both pairs ship until the old ones
// are gone from the connector list, because the alternative is telling a
// user whose connector works today that their rules stopped matching for a
// reason they cannot see.
//
// Order matters only for what a person reads first: the canonical spelling
// leads, so the block someone copies opens with the name the docs told them
// to use rather than the one being retired.
const ALLOW_RULE_SERVER_NAMES = Object.freeze([
  SERVER_NAME, 'Homeroom', 'usernode', 'Usernode',
]);

// ── Allow-listed, but NOT reads (#1405) ────────────────────────────────
//
// A separate list on purpose. `READ_ONLY_TOOL_EXCEPTIONS` answers "is this
// tool a read?", and these two are not — they write a row. Folding them in
// would make the naming contract above say something false, and that contract
// is what the `get_*` / `list_*` globs' safety rests on.
//
// What they are instead is SELF-SCOPED: the only thing they touch is the
// caller's own notification feed. They spend nothing, reach no app, are
// invisible to the group, and cannot be aimed at another user — the target is
// the connection's own identity, never input. Every ACTING tool puts something
// in front of other people; these put a line in front of you. Granting them is
// a decision about your own attention, which a scaffolded repo may reasonably
// make on a stranger's machine where "every call this connector can make"
// would not be.
//
// Listed literally rather than as a `notify_*` glob: a glob is a standing
// promise about every future tool that happens to start that way.
const SELF_SCOPED_ALLOW_TOOLS = Object.freeze([
  'notify_awaiting_input',
  'notify_input_received',
]);

// The read-only allow rules Homeroom ships in the app scaffold and
// documents. Two globs plus one literal per covered spelling, and
// deliberately NOT the whole-server `mcp__homeroom__*`.
//
// The reason is the SCAFFOLD, not the tools. These rules are committed into
// every app repo Homeroom creates, and a repo that grants a connector blanket
// approval on a stranger's machine is exactly what the workspace trust dialog
// exists to catch — the dialog lists what is being granted, and "every call
// this connector can make" is not a reviewable thing to hand someone. Reads
// are. A user who wants the acting tools allowed too can say so on their own
// account, in Settings → Connectors or their own `~/.claude/settings.json`;
// that is their call to make about their own machine, not the scaffold's to
// make for them.
//
// They stay durable only while the naming contract below holds. Tests
// enforce it against the registered tool surface.
//
// #1405 adds a SECOND literal, for the same reason `whoami` is one: the two
// awaiting-input tools do not fit the read prefixes, and they are called at the
// boundaries of ordinary turns — a prompt on every call would make them worse
// than not having the feature at all.
//
// They earn the exception on the same ground `whoami` does. Every ACTING tool
// puts something in front of OTHER PEOPLE: a request on a board, a proposal at
// a vote, a build against a credit balance. These put a line in the caller's
// own notification feed and nothing else. They spend nothing, touch no app,
// are invisible to the group, and cannot be aimed at another user — the target
// is the connection's own identity, never input. Granting them is a decision
// about your own attention, which is exactly the kind a scaffolded repo may
// reasonably make on a stranger's machine.
//
// Still literals rather than a `notify_*` glob: a glob is a standing promise
// about every future tool that happens to start that way, and this is a
// promise about these two.
const READ_ONLY_ALLOW_RULES = Object.freeze(
  ALLOW_RULE_SERVER_NAMES.flatMap((name) => [
    `mcp__${name}__get_*`,
    `mcp__${name}__list_*`,
    `mcp__${name}__whoami`,
    ...SELF_SCOPED_ALLOW_TOOLS.map((tool) => `mcp__${name}__${tool}`),
  ])
);

// ── The tool-naming contract ───────────────────────────────────────────
//
// A CONTRACT, not a description: the two globs above are only as safe as
// this rule is true.
//
//   * A read-only tool is named `get_*` or `list_*`.
//   * A tool that ACTS — files something, spends an allowance, opens or
//     advances a proposal — is NEVER named `get_*` or `list_*`.
//
// `whoami` is the single grandfathered exception, which is why it has its
// own literal entry rather than a glob.
//
// Adding a read-only tool: name it `get_`/`list_` and it is allowed by the
// rules already in every scaffolded repo, with no migration. Adding an
// acting tool: give it any other name and add it to ACTING_TOOLS in
// services/mcp-tools.js, which keeps it out of the setup hint and out of
// these rules.
const READ_ONLY_TOOL_PREFIXES = Object.freeze(['get_', 'list_']);
const READ_ONLY_TOOL_EXCEPTIONS = Object.freeze(['whoami']);


// ── What the client silently cuts ──────────────────────────────────────
//
// Claude Code applies a plain `str.slice(0, 2048)` to two fields it receives
// from an MCP server: `InitializeResult.instructions` and EVERY tool
// `description`. The instructions case at least logs ("Server instructions
// truncated from 5181 to 2048 chars"); the description case logs nothing at
// all, and `/mcp` renders the full text, so the only way to see it is to
// count the characters yourself. Upstream: anthropics/claude-code#81268.
//
// Neither budget below is the client's 2048. Both leave deliberate headroom,
// for three reasons: the cap is a client-side constant that has already been
// renamed once (`WoH` → `D$` in 2.1.220) and could change value as easily;
// other clients may pick a smaller one; and a field sitting at 99% of the
// limit fails the moment somebody adds a sentence, which is exactly the
// silent failure this is here to prevent.
//
// Tool RESULTS are not capped by any of this — which is why the full
// operating charter is delivered as one (services/mcp-charter.js), next to
// the 32 KB of platform conventions get_platform_conventions already returns.
//
// tests/mcp-instruction-budget.test.js enforces both, measuring the RESOLVED
// descriptions off a registration recorder rather than the source text, so a
// description assembled from constants is measured as the client sees it.
// 1400 -> 1536, which is the CEILING the headroom invariant permits, not a
// number picked to fit one more sentence.
//
// The budget had been reached: SERVER_INSTRUCTIONS measured 1399 of 1400, so
// the next brief of any length failed the build. That is the guard working
// exactly as designed — it fails LOUDLY — but it meant the field was full,
// and the section that hit it is one that protects an ANSWER rather than a
// diff: an agent reading a stale fork reports findings about a version of the
// app that no longer exists, and nothing inside the checkout can tell it so.
//
// Why 1536 and not more: tests/mcp-instruction-budget.test.js asserts this
// budget keeps at least 512 characters clear of the client's 2048, and 1536
// is where that runs out. That invariant is the whole point of having a
// number below the client's — raising IT to make room would turn the guard
// into a restatement of the bug, which is what its own comment warns against.
// So the budget moves to the edge of what is already allowed and no further.
//
// What this deliberately does NOT buy is room for the next addition. At 1530
// of 1536 the build fails again on anything substantial, and that is correct:
// content sitting close under the budget is not a safety problem, because it
// fails at require time rather than silently. A brief earns its place here or
// it lives in the section's `text`, where nothing is capped.
const SERVER_INSTRUCTIONS_MAX_CHARS = 1536;
const TOOL_DESCRIPTION_MAX_CHARS = 1800;

module.exports = {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  DELEGATED_TOKEN_PREFIX,
  DELEGATION_KINDS,
  DELEGATED_CLIENT_IDS,
  DELEGATED_CLIENT_NAMES,
  DELEGATION_MAX_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  MCP_PATH,
  CONSENT_PATH,
  DEFAULT_REDIRECT_HOSTS,
  TOKEN_RATE_PER_MINUTE,
  IP_RATE_PER_MINUTE,
  REGISTER_RATE_PER_MINUTE,
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_VERSION_BASE,
  serverVersionFor,
  ALLOW_RULE_SERVER_NAMES,
  READ_ONLY_ALLOW_RULES,
  SELF_SCOPED_ALLOW_TOOLS,
  READ_ONLY_TOOL_PREFIXES,
  READ_ONLY_TOOL_EXCEPTIONS,
  SERVER_INSTRUCTIONS_MAX_CHARS,
  TOOL_DESCRIPTION_MAX_CHARS,
};
