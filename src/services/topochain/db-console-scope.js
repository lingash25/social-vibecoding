// The admin SQL console's TABLE SCOPE — EVERY base table in `public`,
// minus the credential-bearing COLUMNS inside them.
//
// WHY THIS FILE EXISTS: the console (`#admin/seasons/sql-console`) shipped
// scoped to `db-allowlist.js`'s 20 topochain tables, because that is what
// the topochain SPEC's D10 task asked for. The console is, in practice,
// the platform's only browse-any-table surface for an admin who is
// already looking at the admin console — and an admin who cannot see
// `apps`, `events` or `chat_sessions` from it just goes and reads them
// some other way (the unredacted `pg_dump` behind `#admin/db-export`, or
// the prod-debug SQL proxy) with strictly LESS redaction than this
// console applies. So the scope was widened to the whole `public` schema.
//
// #1130 FIXED THE HALF-WIDENING THAT LEFT BEHIND. That first widening
// borrowed BOTH of `services/debug-access.js`'s deny lists — its
// per-column one AND its per-TABLE one — so 20 tables stayed invisible
// and unqueryable, and an admin debugging push notifications got
//
//     Query references table(s) that are not available in this console:
//     mobile_push_deliveries, mobile_push_registrations.
//
// on a delivery-queue table that holds no credential at all. That
// table-level list is the right shape for the OTHER capability (see
// below); it is the wrong shape here. So the console now denies
// CREDENTIAL COLUMNS instead of whole tables: `mobile_push_deliveries`
// is fully readable, `mobile_push_registrations` is readable with
// `registration_enc`/`registration_hash` masked out, `sessions` is
// readable with `token` masked out, and so on for all 12 entries in
// `CONSOLE_CREDENTIAL_COLUMNS` below. What is BROWSABLE widens to all
// ~108 base tables; what is READABLE does not widen by one value.
//
// WHY THE TWO CAPABILITIES DELIBERATELY DIVERGE — and why this is not
// drift to be tidied up later:
//   * `usernode_debug_ro` (debug-access.js) is reached by an AUTOMATED
//     coding agent from a separate process, over a separate pool, with a
//     separate password, on production. A whole-table denial is the right
//     blast radius there: the agent has no business at all inside an
//     auth-token table, and the coarse list is cheap to audit.
//   * `topochain_console_ro` (this module) is reached by a signed-in
//     human platform admin who is already able to read the SAME rows
//     with LESS redaction two clicks away. Denying a whole table here
//     buys no confidentiality — it only pushes the admin onto a less
//     redacted path — while costing them the ability to debug.
// `DENIED_COLUMNS` is still SHARED (imported below, never restated), so
// a credential column added for one capability lands on both. Only the
// table list is console-specific. `tests/topochain-db-tools.test.js`
// asserts the divergence on purpose, so nobody "fixes" it by re-copying
// the table list.
//
// ON TOP of the shared column list, two more sources are merged in:
// `db-allowlist.js`'s `EXCLUDED_EXPORT_COLUMNS` (so the topochain
// export's own column redactions can never be narrower here than there)
// and `CONSOLE_CREDENTIAL_COLUMNS` — the per-column replacement for the
// 20 formerly-denied tables. Union semantics throughout: whichever list
// names a column, it is denied.
//
// OUT OF SCOPE, STRUCTURALLY: `credentials.user_ai_credentials`. The
// inventory query below is `nspname = 'public'`, and that table
// lives in the separate `credentials` schema, which the console role is
// never granted USAGE on. It therefore needs no deny entry of any kind —
// it cannot appear in the scope, be granted, or be selected from.
//
// WHAT ENFORCES IT, IN ORDER OF WHO ACTUALLY DECIDES:
//   1. `db-console-role.js` — grants `topochain_console_ro` SELECT on
//      exactly the tables this module resolves, with COLUMN-LEVEL grants
//      wherever a table has denied columns. This is the security
//      boundary: Postgres itself refuses a denied column through ANY
//      access path (`SELECT *`, `row_to_json`, a cast, a comma join, a
//      function nobody has thought of yet).
//   2. `sql-console.js`'s `validateStatement` — a fast, specific 400
//      instead of a bare "permission denied" round trip. A UX layer, and
//      documented as one in that file's header.
//   3. `db-schema-info.js` — what the console's schema browser LISTS, so
//      an admin is never shown a table or column every query against it
//      then gets rejected for touching.
// All three resolve their scope from THIS module, so they cannot drift.
//
// `db-allowlist.js` is untouched and still means what it always meant:
// the scope of the topochain SQL EXPORT (a FK-ordered dump that replays
// into a fresh database). That is a deliberately different, much
// narrower thing than "which tables may an admin SELECT from", and
// widening the export was never asked for.
'use strict';

const { DENIED_COLUMNS } = require('../debug-access');
const { EXCLUDED_EXPORT_COLUMNS } = require('./db-allowlist');

// Tables the console never lists, never grants, and rejects by name.
//
// DELIBERATELY EMPTY (#1130). It is kept — rather than deleted along
// with `isDeniedTable` — as the escape hatch for a future table that is
// genuinely un-maskable at column granularity: one where the ROW'S
// EXISTENCE, not any single column's value, is the secret. Nothing in
// the schema is like that today. Everything that used to be here is now
// a `CONSOLE_CREDENTIAL_COLUMNS` entry instead, because masking the
// credential column and leaving the row's shape readable is what makes
// the console usable for debugging without making it a secret reader.
//
// If you are about to add a table here, first check that the thing you
// want to hide is not just one column. If it is, add it below instead.
const DENIED_CONSOLE_TABLES = new Set([]);

// Tables denied wholesale to the automated production-debug role but
// intentionally readable through the signed-in admin SQL console because
// they contain no credential value to mask. Keep this policy declaration in
// the scope module (rather than only in a test) so each new prod-debug table
// denial has an explicit console-side review decision.
//
// Platform Messages belongs here as a domain: its rows are private user data,
// which is why coding agents cannot query them in production, but none of the
// tables stores a password, token, encrypted destination, or other reusable
// credential. This follows the console's existing human-admin policy; it does
// not widen the separate `usernode_debug_ro` role.
const FULLY_READABLE_CONSOLE_TABLES = new Set([
  'mobile_push_deliveries',
  'mobile_push_deployment_state',
  'mobile_push_installation_mutations',
  'mobile_push_registration_events',
  'cli_auth_audit_events',
  'cli_auth_rate_limits',
  // The shared limiters' counts: a hash of what each counts, a number and
  // when its window ends. Nothing in it signs anybody in.
  'rate_limit_hits',
  'mcp_clients',
  'mcp_auth_audit_events',
  // Delegated connector grants (#2779): who holds a grant, of which kind, for
  // which change, and until when. The bearer itself lives in mcp_tokens,
  // whose hash and hint stay masked.
  'mcp_delegations',
  'user_agent_files',
  'moderation_cases',
  'moderation_reports',
  'moderation_evidence_files',
  'moderation_report_files',
  'moderation_actions',
  'moderation_message_originals',
  'profile_reports',
  // Lifecycle rows without bearer/envelope material. Opaque ids, public
  // installation keys and state transitions remain useful for human-admin
  // diagnosis; the credential-bearing sibling columns are masked below.
  'native_session_web_incarnations',
  'native_session_attempts',
  'native_installation_key_generations',
  'conversations',
  'conversation_direct_pairs',
  'conversation_members',
  'conversation_messages',
  'conversation_message_reactions',
  'conversation_message_attachments',
  'conversation_message_objects',
  'chat_session_spec_conversation_shares',
  'user_app_blocks',
  'user_blocks',
  // Mutual friends (#2386): private relationships, like user_blocks beside
  // them, and no credential among their columns.
  'friendships',
  'friend_request_sends',
  'friend_request_declines',
  'conversation_message_reports',
  'app_reports',
  'chat_message_reports',
  // Global Chat transcript rows are private user data, which keeps them out
  // of the automated production-debug role. The signed-in human-admin console
  // already follows the same deliberate policy for platform Messages above:
  // transcript/summary rows are readable for diagnosis. Tool action inputs
  // and authoritative results are sealed at rest before they reach this
  // table, so the console sees ciphertext rather than executable payloads.
  'global_chat_threads',
  'global_chat_messages',
  'global_chat_tool_runs',
  // Private requests (#5048): admin-only confidential requests and their
  // comments, kept off GitHub. Every admin can already read them in the
  // Workshop, and no column holds a credential; the automated debug role
  // stays denied.
  'private_requests',
  'private_request_comments',
]);

// The per-column replacement for the old table-level denials — one entry
// per formerly-denied `public` table that actually stores a secret, each
// naming ONLY the columns whose VALUES are credentials. Everything else
// on those tables (ids, FKs, timestamps, status/attempt counters,
// environments, platforms) is readable, which is the entire point:
// `SELECT status, attempts, last_error_code FROM mobile_push_deliveries`
// is the query #1130 was filed about.
//
// A table that appeared on the old list but stores NO credential gets no
// entry at all and is fully readable: `mobile_push_deliveries`,
// `mobile_push_deployment_state`, `mobile_push_installation_mutations`,
// `cli_auth_audit_events`, `cli_auth_rate_limits`, `mcp_clients`,
// `mcp_auth_audit_events`, `user_agent_files`, `profile_reports`. The last is
// moderation material rather than a credential: a full admin can already read
// the same reporter/reason/detail rows through /api/admin/profile-reports, so
// masking them here would only push that admin onto the less flexible route.
//
// Column names are checked against `src/db/schema.sql` by a test in
// `tests/topochain-db-tools.test.js`, which also sweeps every
// `CREATE TABLE` / `ALTER TABLE … ADD COLUMN` for credential-shaped
// names and fails on one that is neither denied nor explicitly reviewed.
const CONSOLE_CREDENTIAL_COLUMNS = {
  // Live login cookie values — a readable `token` is a session takeover.
  sessions: ['token'],
  // Redeemable invite codes.
  activation_codes: ['code'],
  // Invite links (services/community-invites.js): a live token is a way
  // into a project, a private group's included. Who made it, its limits and
  // its use count stay readable, which is what a "my link did not work"
  // question needs.
  community_invites: ['token'],
  // Encrypted app secrets + the last-4 hint that narrows a guess.
  app_secrets: ['value_enc', 'value_last4'],
  platform_env_values: ['value_enc', 'value_last4'],
  // Same pair, pre-application. `declaration` (what the agent asked for,
  // and why) stays readable — that is the useful half for debugging.
  pending_secret_declarations: ['value_enc', 'value_last4'],
  // Login OTP / bearer-token hashes. Hashed, but offline-guessable for a
  // 6-digit code, and a token hash is a bearer credential in the
  // lookup-by-hash schemes these tables use.
  mobile_otp_codes: ['code_hash'],
  // Homeroom's own SMS sign-in codes (services/sms/otp.js), used when Brevo
  // sends the text: the session handed to the client and the code are
  // stored as SHA-256 hashes, and a six-digit code's hash is
  // offline-guessable, so both are masked. attempts/expires_at stay
  // readable, which is what "my code did not work" needs.
  sms_otp_codes: ['session_hash', 'code_hash'],
  // Account email proof and the password snapshot are both offline-guessable.
  account_email_verifications: ['code_hash', 'password_hash'],
  // #5281: the username-change proof, the same two secrets as the row above.
  account_username_codes: ['code_hash', 'password_hash'],
  web_signup_sessions: ['token_hash'],
  // Apple and Google sign-in (services/sign-in-providers.js). The provider
  // settings' secret is a client secret or a private key; the round trip's
  // state, binder, nonce and PKCE verifier would let a callback be forged;
  // the username step's hash is a bearer continuation. Which provider is on,
  // its IDs and who changed it stay readable, and so does every linked
  // identity (user_oauth_identities), which is what "I cannot sign in with
  // Google" needs.
  sign_in_providers: ['secret_enc'],
  // The read-only roles the leader sets up (services/debug-access.js): the
  // prod-debug role's password, encrypted. Whether each setup succeeded,
  // when and on which release stay readable.
  platform_db_roles: ['secret_enc'],
  oauth_sign_in_states: ['state_hash', 'binder_hash', 'nonce', 'code_verifier'],
  oauth_signup_sessions: ['token_hash'],
  // A spent native sign-in's ID token, hashed: nothing to read in it, and
  // nothing a console needs.
  native_sign_in_tokens: ['token_hash'],
  mobile_auth_tokens: ['token_hash'],
  // The waitlist's own email verification code, same shape and same
  // reasoning as mobile_otp_codes above: bcrypt, but a six-digit space is
  // offline-guessable, and this hash confirms an address. Everything else
  // on the row — attempts, expires_at, consumed_at — is exactly what
  // debugging "my code did not work" needs, so only the hash is masked.
  waitlist_verification_codes: ['code_hash'],
  // The release mail's one-time sign-in link (#4594): a hash looked up by
  // hash is a bearer credential. Its row, expiry and use stay readable.
  waitlist_release_links: ['token_hash'],
  native_session_handoffs: ['handoff_hash'],
  native_session_tickets: ['ticket_hash', 'encrypted_response'],
  native_session_credentials: [
    'credential_reference', 'credential_generation', 'mobile_auth_token_id',
  ],
  native_session_credential_envelopes: [
    'credential_reference', 'compact_jwe', 'encrypted_response',
  ],
  native_epoch_delegation_policies: [
    'credential_reference', 'credential_generation',
  ],
  // The encrypted FCM destination and its lookup hash. Every other
  // column (platform, permission_status, session_expires_at, last_seen_at)
  // is exactly what push debugging needs.
  mobile_push_registrations: [
    'native_session_credential_reference', 'registration_enc', 'registration_hash',
  ],
  // Device-flow: the polled device code's hash, the user-visible pairing
  // code (live and typeable while pending), and the requester's IP —
  // masked for the same reason `users.waitlist_ip` is.
  cli_device_authorizations: ['device_code_hash', 'user_code', 'request_ip'],
  cli_access_tokens: ['token_hash', 'token_hint'],
  // PKCE: the code's hash is the credential. `code_challenge` is the
  // public half of the exchange and stays readable.
  mcp_authorization_codes: ['code_hash'],
  mcp_tokens: ['token_hash', 'token_hint'],
  // Work-order patch upload credentials (#4264): the hash locates a live
  // upload capability. Which task it is for, and until when, stay readable.
  external_agent_upload_tokens: ['token_hash'],
  // Connector uploads (services/connector-uploads.js): the hash locates a
  // live upload capability, and `data` is a plan nobody has posted yet.
  // Whose it is, its kind, size and expiry stay readable.
  connector_uploads: ['token_hash', 'data'],
  // A platform preview's project credential (services/preview-projects.js):
  // the hash. Which session it is for, and until when, stay readable. A
  // project made in a preview: its database role's password. Its state,
  // error, image and host are what debugging it needs and stay readable.
  preview_project_tokens: ['token_hash'],
  preview_projects: ['db_password'],
  // What a preview sent for a build or a deploy, kept for the conductor:
  // its source and its env (the project's own settings and secrets).
  preview_project_inputs: ['files', 'env'],
  // What a platform operation carries past its request's 64 KB, kept for the
  // conductor (services/platform-operations.js): a commit's files or a
  // patch. Which operation and request it is for, and when, stay readable.
  platform_operation_inputs: ['payload'],
  // Social identity is private account metadata. The short-lived OAuth row
  // additionally contains the callback-state hash and live PKCE verifier.
  user_social_identities: ['provider_subject', 'handle'],
  social_identity_oauth_states: ['state_hash', 'pkce_verifier'],
  // A wallet sign-in's challenge: its hash is the single-use credential.
  // Which address it was minted for, and until when, stay readable.
  wallet_challenges: ['challenge_hash'],
  // A waitlist signer's social-connect round trip: the state's hash, the
  // capability token it carries, and X's live PKCE verifier. How it ended
  // stays readable.
  waitlist_connect_states: ['state_hash', 'token', 'verifier'],
  // A database export's download ticket, kept on its audit row as a hash
  // until it is redeemed (services/db-export.js). The rest of the audit
  // trail (who, when, how it ended) stays readable.
  db_exports: ['ticket_hash'],
  social_identity_pending_replacements: ['provider_subject', 'handle'],
  // Public report share links. `share_token` is the SOLE access control on
  // the unauthenticated /reports/:token route (schema.sql says so outright),
  // so it is a plaintext bearer credential even though the rest of the row
  // is ordinary report metadata. `shared_at` — whether a snapshot is
  // shared, and since when — stays readable, which is the debuggable half.
  app_report_snapshots: ['share_token'],
  // One-use Global Chat confirmations: preserve lifecycle metadata for human
  // admin diagnosis while masking both lookup fingerprints and the sealed
  // exact action payload. This mirrors debug-access.js explicitly so adding a
  // new whole-table denial always has a reviewed console-side decision.
  global_chat_action_tokens: ['token_hash', 'input_hash', 'normalized_input'],
  // The agent-session Mayor's confirmation cards (#2779): the lifecycle
  // columns stay readable for diagnosis; the sealed input and its
  // fingerprint do not.
  agent_session_actions: ['input_hash', 'sealed_input'],
  // The same for an admin's confirm cards in their chat with Homeroom bot
  // (homeroom-bot-thread-tools/admin.js).
  homeroom_bot_admin_actions: ['input_hash', 'sealed_input'],
};

// Columns denied per table: the prod-debug list, the topochain export's
// own column exclusions, and the console's per-column credential map,
// merged. Union semantics — whichever list names a column, it is denied.
const DENIED_CONSOLE_COLUMNS = (() => {
  const merged = {};
  for (const source of [DENIED_COLUMNS, EXCLUDED_EXPORT_COLUMNS, CONSOLE_CREDENTIAL_COLUMNS]) {
    for (const [table, columns] of Object.entries(source || {})) {
      merged[table] = [...new Set([...(merged[table] || []), ...columns])];
    }
  }
  return merged;
})();

// Postgres identifiers we are willing to splice into a GRANT statement.
// Anything else is skipped rather than quoted-and-hoped-for; the platform
// has no such table or column, so skipping is a no-op in practice and a
// hard stop for a hypothetical hostile identifier.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

// Every base table in `public` with its column list, in column order.
// Base tables only (`relkind` 'r', or 'p' for a partitioned one, which is
// what information_schema calls BASE TABLE) skips views and materialized
// views deliberately: the console's role is granted per-table, and a view
// would need its own grant plus grants on whatever it selects from — out
// of scope for "list the tables".
//
// Read from the system catalog, not from `information_schema.columns`
// joined to `information_schema.tables`: Postgres re-evaluated the column
// view once per table for that join, about 0.2 s on an idle server, and
// this runs first on every schema-browser fetch (see db-schema-info.js).
// The privilege test is the one information_schema applies, so a column
// the caller cannot see is left out exactly as before.
// `tests/topochain-db-schema-catalog-postgres.test.js` asserts the rows
// match the old query's on the full schema.
const TABLE_INVENTORY_SQL = `
  SELECT c.relname::text AS table,
         array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND (pg_has_role(c.relowner, 'USAGE')
       OR has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))
   GROUP BY c.relname
   ORDER BY c.relname
`;

// ── The cached scope ────────────────────────────────────────────────────
//
// `validateStatement` is synchronous (it is called from a request handler
// that has already decided not to touch the database yet), so the set of
// real table names has to be available without awaiting. It is loaded at
// boot by `db-console-role.js`'s grant refresh and again on every schema
// -browser fetch, both of which call `loadConsoleScope` below.
//
// Until the first load, `knownTables()` is EMPTY, and every consumer
// treats that as "I don't know the table list yet" rather than "no table
// is allowed" — see `sql-console.js`'s scope check, which then falls back
// to the deny list alone. That ordering matters: the alternative
// (empty set == reject everything) would turn a slow first load into a
// console that rejects every query with a nonsense reason.
let _tables = [];
let _tableSet = new Set();

// Kept for the escape hatch above (and so the fallback path in
// `sql-console.js` has something to ask). Answers `false` for everything
// while `DENIED_CONSOLE_TABLES` is empty.
function isDeniedTable(name) {
  return DENIED_CONSOLE_TABLES.has(String(name).toLowerCase());
}

function isDeniedColumn(table, column) {
  const denied = DENIED_CONSOLE_COLUMNS[table];
  return !!denied && denied.includes(column);
}

// Denied column names for a set/array of referenced table names — what
// `sql-console.js` uses to reject `SELECT u.password FROM ... users u`
// without blanket-denying the word "password" (or, worse, generic names
// like `data`, `ip`, `token` and `code`) for every other table in the
// database. That table-awareness is load-bearing now that the denied
// names include `token`, `code` and `user_code`: those appear as
// perfectly readable columns on other tables.
function deniedColumnsForTables(tables) {
  const names = new Set();
  for (const table of tables) {
    for (const column of DENIED_CONSOLE_COLUMNS[String(table).toLowerCase()] || []) {
      names.add(column);
    }
  }
  return names;
}

// Loads (and caches) the live scope: `[{ table, columns }]`, alphabetical
// by table, denied columns filtered out. A table whose EVERY column is
// denied is dropped — there would be nothing to select from it.
async function loadConsoleScope(pool) {
  const { rows } = await pool.query(TABLE_INVENTORY_SQL);
  const scope = [];
  for (const row of rows || []) {
    const table = row.table;
    if (!SAFE_IDENT.test(table) || isDeniedTable(table)) continue;
    const columns = (row.columns || []).filter(
      (c) => SAFE_IDENT.test(c) && !isDeniedColumn(table, c)
    );
    if (!columns.length) continue;
    scope.push({ table, columns });
  }
  // Alphabetical, so the schema browser's ~108-entry list is scannable
  // and stable across calls regardless of what order Postgres answered
  // in.
  scope.sort((a, b) => a.table.localeCompare(b.table));
  _tables = scope.map((e) => e.table);
  _tableSet = new Set(_tables);
  return scope;
}

function knownTables() {
  return _tables;
}

function knownTableSet() {
  return _tableSet;
}

// Test-only helpers: seed / clear the cache without a database.
function _setKnownTablesForTests(names) {
  _tables = [...names];
  _tableSet = new Set(_tables);
}

function _resetForTests() {
  _tables = [];
  _tableSet = new Set();
}

module.exports = {
  DENIED_CONSOLE_TABLES,
  FULLY_READABLE_CONSOLE_TABLES,
  DENIED_CONSOLE_COLUMNS,
  CONSOLE_CREDENTIAL_COLUMNS,
  TABLE_INVENTORY_SQL,
  SAFE_IDENT,
  isDeniedTable,
  isDeniedColumn,
  deniedColumnsForTables,
  loadConsoleScope,
  knownTables,
  knownTableSet,
  _setKnownTablesForTests,
  _resetForTests,
};
