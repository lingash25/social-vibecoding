'use strict';

// #616: read-only production access for admin dev sessions on the
// self-edit app.
//
// The Claude Code worker never receives a DB credential or the docker
// socket — it shares a docker network with usernode-db, so any static
// credential handed to one worker would be usable from EVERY worker
// container. Instead the worker calls session-scoped, claim-gated
// internal API endpoints (src/routes/internal.js "prod-debug" routes)
// and the platform executes the reads on its side:
//
//   - SQL runs through a dedicated `usernode_debug_ro` Postgres role
//     whose password each release's migration step regenerates
//     (services/db-roles.js), and whose grants expose only reviewed
//     operational columns (READABLE_COLUMNS below). Every process
//     reads it from platform_db_roles, encrypted with the data key as app
//     secrets are, a table this role itself cannot read.
//   - docker reads (`docker logs`, `docker ps`) run via the platform's
//     existing docker.js helpers against an allowlist of container
//     names.
//
// Same proxy philosophy as the anthropic proxy and the push proxy in
// services/worker.js: the real credential never enters the worker.

const crypto = require('crypto');
const { Pool } = require('pg');
const { getPool } = require('../db/pool');
const log = require('./logger');
const secrets = require('./secrets');
const { verifyDebugRole } = require('./debug-role-policy');

const ROLE = 'usernode_debug_ro';
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

// Query execution limits for the SQL proxy.
const QUERY_TIMEOUT_MS = 5000;
const MAX_ROWS = 500;
const MAX_RESULT_BYTES = 256 * 1024;

// ── Deny lists ──────────────────────────────────────────────────────────
//
// Legacy exclusions for credentials/private content, also used by the
// human-admin console's separate policy. Kept in sync with the
// `staging:private` credential tags in src/db/schema.sql — a new
// secret-bearing column/table added there MUST be added here too (a test
// in tests/prod-debug-access.test.js cross-checks the schema tags against
// this list). Note this is deliberately much smaller than the full
// `staging:private` set: tables like chat_sessions and merge_debug_runs
// are private-to-staging but are exactly what a production debugger
// needs as operational metadata. The SQL role's READABLE_COLUMNS below
// now determines every grant; an unknown table or column is excluded even
// before these older exclusion lists are updated.
const DENIED_TABLES = new Set([
  'sessions',           // login cookie tokens
  'activation_codes',   // invite/activation secrets
  'app_secrets',        // per-app env secrets (AES blobs, still deny)
  'user_agent_files',   // personal instruction files (private user text)
  'platform_env_values', // platform's own env values (AES blobs, still deny)
  'pending_secret_declarations', // values held for a declaration PR (AES blobs)
  'account_email_verifications', // mailbox proof and current-password hash snapshot
  'account_username_codes', // #5281 username-change mailbox proof and password hash snapshot
  'mobile_otp_codes',   // hashed one-time email signup/claim codes
  'waitlist_verification_codes', // one-time waitlist email codes, same treatment as mobile_otp_codes
  'waitlist_release_links', // hashed one-time sign-in links from the release mail (#4594)
  'web_signup_sessions', // hashed, single-use first-password continuations
  'sign_in_providers',  // Apple/Google client secrets and private keys (AES blobs, still deny)
  'oauth_sign_in_states', // Apple/Google round trips: state, binder, nonce, PKCE verifier
  'oauth_signup_sessions', // hashed, single-use username-step continuations
  'native_sign_in_tokens', // hashes of spent native Apple/Google ID tokens
  'mobile_auth_tokens', // protocol-2 native bearer hashes
  'native_session_web_incarnations', // protocol-2 web-session security lineage
  'native_session_attempts', // protocol-2 subject/network binding
  'native_session_handoffs', // short-lived native redemption lineage
  'native_session_tickets', // hashed tickets + encrypted exact replay
  'native_installation_key_generations', // installation continuity keys
  'native_session_credentials', // native credential/revocation lineage
  'native_session_credential_envelopes', // compact JWE + encrypted exact replay
  'native_epoch_delegation_policies', // credential-bound producer policy lineage
  'mobile_push_deployment_state', // trusted push deployment identity and activation state
  'mobile_push_installation_mutations', // private device mutation fences
  'mobile_push_registrations', // encrypted FCM destinations
  'mobile_push_registration_events', // private device registration lifecycle metadata
  'mobile_push_deliveries', // private notification/device delivery metadata
  'cli_device_authorizations', // global CLI device codes and request IPs
  'cli_access_tokens',   // global CLI bearer hashes and hints
  'cli_auth_audit_events', // security audit trail for CLI credentials
  'cli_auth_rate_limits', // shared security limiter state
  'moderation_cases',
  'moderation_reports',
  'moderation_evidence_files',
  'moderation_report_files',
  'moderation_actions',
  'moderation_message_originals',
  'profile_reports',      // private abuse reports and reporter identities
  'conversations',        // private platform messaging metadata
  'conversation_direct_pairs', // private messaging relationships
  'conversation_members', // private conversation membership/invites/read state
  'conversation_messages', // private message bodies and reply metadata
  'conversation_message_reactions', // private social interactions
  'conversation_message_attachments', // private attachment bytes + metadata
  'conversation_message_objects', // private shared-object activity
  'chat_session_spec_conversation_shares', // private spec access grants
  'user_app_blocks',
  'user_blocks',          // private user safety relationships
  'friendships',          // private friend graph and pending requests (#2386)
  'friend_request_declines', // who declined whom — silent by product rule (#2386)
  'friend_request_sends', // per-person request activity (#2386)
  'conversation_message_reports', // private abuse evidence and reporter identity
  'app_reports',             // private mini-app report details and reporter identity
  'chat_message_reports',    // private Workshop post evidence and reporter identity
  'mcp_clients',              // hosted-connector client registrations
  'mcp_authorization_codes',  // hosted-connector PKCE codes (hashed, short-lived)
  'mcp_tokens',               // hosted-connector bearer hashes and hints
  'mcp_delegations',          // which of the platform's own agents holds a grant for whom (#2779)
  'mcp_auth_audit_events',    // security audit trail for connector credentials
  'external_agent_upload_tokens', // one-time work-order patch upload credential hashes (#4264)
  'connector_uploads',       // one-time connector upload credential hashes and unposted plans
  'preview_project_tokens',   // platform previews' project credential hashes (preview-projects.js)
  'preview_projects',         // projects made in platform previews, with their database passwords
  'user_social_identities',   // private provider ownership proofs
  'social_identity_oauth_states', // social-link state hashes + PKCE verifiers
  'wallet_challenges',        // wallet sign-in challenge hashes, single use
  'waitlist_connect_states',  // waitlist social-connect state hashes, capability tokens, PKCE verifiers
  'rate_limit_hits',          // shared limiter counts, by hashed address or account
  'social_identity_pending_replacements', // short-lived verified account replacements
  'user_ai_credentials', // per-user AI/LLM provider keys (encrypted blobs, still deny)
  'global_chat_threads', // private assistant summaries and ownership
  'global_chat_messages', // private user/assistant transcript content
  'global_chat_tool_runs', // private action inputs and authoritative results
  'global_chat_action_tokens', // one-use action capabilities and sealed payloads
  'agent_session_actions', // the agent-session Mayor's sealed confirmation cards (#2779)
  'homeroom_bot_admin_actions', // Homeroom bot's sealed admin confirm cards (bot parity P7)
  'private_requests',         // admin-only confidential and security requests, kept off GitHub (#5048)
  'private_request_comments', // their discussion (#5048)
  'platform_db_roles',   // this role's own password, encrypted (AES blob, still deny)
]);

const DENIED_COLUMNS = {
  users: [
    'password',
    'anthropic_key_enc',
    'anthropic_key_last4',
    'wallet_link_token',
    'wallet_link_expires_at',
    'email_confirmation_token', // topochain (SPEC §6)
    'password_reset_token_hash', // email password-reset capability
    'password_reset_expires_at',
    'waitlist_ip',              // topochain (SPEC §6)
    'profile_disabled_reason',  // private moderator rationale
    'github_oauth_token_enc',   // verified GitHub link: the user's OAuth token
  ],
  apps: [
    'db_password',
    'llm_proxy_token',
    'storage_api_token',
  ],
  chat_session_attachments: [
    'data', // raw upload bytes — large and potentially private
  ],
  global_chat_action_tokens: [
    // The first hash locates a one-use write capability; the second is a
    // fingerprint of that capability's exact private action payload.
    'token_hash',
    'input_hash',
    'normalized_input',
  ],
  server_error_minutes: [
    // One scrubbed 5xx message per route and minute: it can still carry
    // what a person sent (services/server-error-counts.js).
    'sample',
  ],
  platform_signals: [
    // Raw evidence behind a problem the platform found in itself (log
    // lines, ids, a project's own build output): full admins read it on the
    // request's page; services/platform-signals.js never publishes it.
    'evidence_private',
  ],
  phone_sign_in_tokens: [
    // SHA-256 digest of a spent Firebase ID token (replay detection) —
    // derived from auth material, so it is denied rather than reviewed.
    'token_hash',
  ],
  test_phone_sign_ins: [
    // bcrypt hash of a live one-time sign-in code for a test number.
    'code_hash',
  ],
  agent_session_actions: [
    // The sealed exact input of a pending write and its fingerprint (#2779).
    'input_hash',
    'sealed_input',
  ],
  homeroom_bot_admin_actions: [
    // The same for an admin's confirm card in their chat with Homeroom bot
    // (homeroom-bot-thread-tools/admin.js).
    'input_hash',
    'sealed_input',
  ],
  onchain_accounts: [
    'secret_key',        // topochain: on-chain account private key (SPEC §6)
    'registration_code', // topochain: single-use account claim code (SPEC §6)
  ],
  // A person's own words to the Homeroom bot, often from their DM with it,
  // tagged staging:private in schema.sql: never read while debugging.
  homeroom_bot_requesters: [
    'asked_text', // what they asked for, in their words
  ],
  homeroom_bot_runs: [
    'plan_change', // what a creator asked the bot's plan changed with; never posted anywhere
    'review', // a first version's review: issues quoting a private project's screens (review_rounds and review_stop stay readable)
    'build_no_change', // a build agent's last message when it changed nothing: can quote a private project's code
    'build_retry', // why a first version's first try failed, which can quote its build agent's last message
    'build_checkpoint', // where a build is between its steps, with its build agent's last message
  ],
  waitlist_signups: [
    'ip',         // submitter IP — same treatment as users.waitlist_ip
    'more_token', // stage-2 survey capability — editing rights over the signup's answers
    'invite_code', // shareable capability — anyone holding it is attributed as this signup's invitee
    'project_invite_id', // which private app_email_invites row (project, inviter) brought this address in
  ],
};

// SQL debug access is metadata-only. Review each column here: schema
// discovery supplies existence, never permission. In particular, transcripts,
// drafts, workflow payloads/results/checkpoints/errors, stream bodies, secrets
// and arbitrary JSON never become readable just because a migration adds them.
// An expansion also needs reviewed types/CHECK constraints in
// debug-access-schema.json. lint:sql verifies the migrated schema and the
// effective role privileges; release setup runs the same verifier below.
// The older exclusions above remain a second check and are shared with the
// separate human-admin SQL console, which has its own deliberate read policy.
const READABLE_COLUMNS = Object.freeze(Object.fromEntries(Object.entries({
  users: ['id', 'username', 'is_admin', 'admin_readonly', 'created_at', 'has_platform_access'],
  apps: ['id', 'slug', 'repo_url', 'status', 'created_by', 'created_at', 'self_hosted',
    'main_sha', 'main_pr_number', 'last_deploy_at', 'runtime_kind', 'runtime_name', 'image_ref',
    'collab_visibility', 'view_visibility', 'main_check_state', 'main_check_sha', 'main_check_at',
    'deploy_state', 'deploy_started_at', 'deploy_from_sha', 'db_size_bytes', 'db_size_measured_at'],
  chat_sessions: ['id', 'app_id', 'user_id', 'status', 'branch_name', 'pr_number', 'created_at',
    'last_activity_at', 'check_state', 'check_phase', 'checks_commit_sha', 'checks_checked_at',
    'consecutive_check_failures', 'check_next_retry_at', 'is_headless', 'headless_status',
    'headless_issue_number', 'headless_outcome', 'headless_step', 'merge_commit_sha',
    'merge_attempt_at', 'promoted_at', 'archived_at', 'merged_at', 'live_at', 'platform_live_at',
    'shots_state', 'shots_run_id', 'shots_updated_at', 'workflow_owner', 'workflow_step'],
  issues: ['id', 'app_id', 'github_issue_number', 'kind', 'created_by', 'status', 'created_at'],
  events: ['id', 'user_id', 'app_id', 'session_id', 'event_type', 'created_at'],
  llm_usage: ['id', 'user_id', 'date', 'total_cost_cents', 'byok_cost_cents'],
  merge_debug_runs: ['id', 'app_id', 'session_id', 'pr_number', 'kind', 'trigger', 'status', 'started_at', 'ended_at'],
  merge_debug_steps: ['id', 'run_id', 'seq', 'phase', 'level', 'created_at'],
  agent_sessions: ['id', 'user_id', 'status', 'focus_app_id', 'active_change_id', 'created_at',
    'last_activity_at', 'last_done_at', 'archived_at', 'seen_at', 'state_version'],
  wf_instances: ['machine', 'key', 'app_id', 'state', 'version', 'machine_version',
    'deadline_at', 'deadline_version', 'flag', 'created_at', 'updated_at'],
  wf_events: ['id', 'machine', 'key', 'app_id', 'type', 'caused_by', 'status', 'attempts',
    'retry_at', 'result', 'machine_version', 'state_before', 'state_after', 'version_after',
    'created_at', 'processed_at'],
  wf_work: ['id', 'machine', 'key', 'kind', 'status', 'attempt_count', 'lost_attempts',
    'lease_until', 'due_at', 'caused_by', 'created_at', 'settled_at'],
  wf_work_attempts: ['id', 'work_id', 'number', 'outcome', 'started_at', 'finished_at'],
  platform_processes: ['id', 'release', 'role', 'state', 'started_at', 'heartbeat_at',
    'drain_started_at', 'drain_deadline_at'],
  session_workers: ['session_id', 'last_used_at', 'created_at'],
  check_runs: ['run_id', 'session_id', 'commit_sha', 'kind', 'app_id', 'queued_at',
    'admitted_at', 'started_at', 'heartbeat_at'],
}).map(([table, columns]) => [table, Object.freeze(columns)])));

// ── Container-log allowlist (used by the prod-debug logs endpoint) ─────
// Every `container_name` docker-compose.yml declares for a platform service,
// and nothing else. `usernode` is kept for pre-blue-green and self-hosted
// single-instance deploys; `usernode-blue` / `usernode-green` are the two
// colours production has actually run since the blue-green rollout, and
// their absence here is why `usernode-debug logs usernode` answered "No such
// container" while the connector's PR failure went uncharacterised for a
// whole afternoon. tests/prod-debug-access.test.js derives the expectation
// from docker-compose.yml, so the next rename cannot silently blind the
// debugger again.
const LOG_CONTAINER_EXACT = new Set([
  'usernode', 'usernode-blue', 'usernode-green',
  'usernode-db', 'usernode-node', 'usernode-minio', 'caddy', 'acme-dns',
]);
const LOG_CONTAINER_PREFIXES = [
  'usernode-app-', 'usernode-staging-', 'usernode-worker-',
];
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 2000;
const MAX_LOG_BYTES = 256 * 1024;

function isAllowedLogContainer(name, runtimeKind = 'docker') {
  if (typeof name !== 'string' || !name) return false;
  if (runtimeKind === 'kubernetes') {
    return name.length <= 63 && /^sv-(?:app-\d+-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|preview-\d+-s\d+|worker-s\d+)$/.test(name);
  }
  // Strict charset first so nothing shell/path-shaped gets near docker.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  if (LOG_CONTAINER_EXACT.has(name)) return true;
  return LOG_CONTAINER_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

function clampTail(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_TAIL;
  return Math.min(n, MAX_LOG_TAIL);
}

// ── Role bootstrap ──────────────────────────────────────────────────────

// Regenerated at every election. In the clear only in memory: the copy in
// platform_db_roles is encrypted (recordBootstrap, loadShared).
let _roPassword = null;
let _roPool = null;
let _available = false;
let _unavailableReason = 'prod-debug role not initialized';
// When this process last read the role's record (loadShared).
let _sharedReadAt = 0;
const SHARED_TTL_MS = 30 * 1000;

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

// Pure: intersect reviewed columns with the actual base-table inventory.
// Unknown tables/columns and views receive no grants. Input shape:
// [{ table, kind: 'r' | 'p' | ..., columns: [...] }].
function buildGrantStatements(tables, role = ROLE) {
  if (!SAFE_IDENT.test(role)) throw new Error('unsafe debug role identifier');
  const stmts = [];
  for (const { table, kind, columns } of tables || []) {
    if (!SAFE_IDENT.test(table)) continue;
    if (kind !== 'r' && kind !== 'p') continue;
    if (DENIED_TABLES.has(table)) continue;
    if (!Object.hasOwn(READABLE_COLUMNS, table)) continue;
    const denied = DENIED_COLUMNS[table] || [];
    const allowed = (columns || []).filter(c => SAFE_IDENT.test(c)
      && READABLE_COLUMNS[table].includes(c) && !denied.includes(c));
    if (!allowed.length) continue;
    stmts.push(`GRANT SELECT (${allowed.map(quoteIdent).join(', ')}) ON public.${quoteIdent(table)} TO ${role}`);
  }
  return stmts;
}

// #891: bounded retry around the whole bootstrap. Granting to this role
// rewrites the same catalog rows (pg_authid for the ALTER ROLEs, every
// table's pg_class ACL for the REVOKE/GRANT sweep) that the topochain
// console role's near-identical bootstrap rewrites, so two of them running
// concurrently makes Postgres raise `tuple concurrently updated` and the
// loser's capability is dead for the whole process lifetime (nothing
// re-invokes ensureRole — see the module header note below). server.js now
// awaits the two in sequence, which removes the in-process collision; this
// retry covers what ordering cannot — an overlapping deploy, where the old
// container's boot sweep is still running as the new one starts.
//
// Retrying the ENTIRE sequence rather than just the grant loop is
// deliberate: the contention can surface on any of the ALTER ROLE / REVOKE
// / GRANT statements, and the sequence is fully idempotent (create-if-
// missing, then unconditional ALTER/REVOKE/GRANT), so re-running from the
// top is always safe.
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 250;

// NOT unref'd, deliberately: this backoff is awaited during boot, before
// the HTTP listener exists. An unref'd timer lets Node consider the loop
// idle and exit, abandoning the retry (and the rest of startup) entirely.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Boot-time ensure (called from server.js after migrate()): create/reset
// the role with a fresh random password, lock it down, and refresh grants
// so tables added by this deploy's migrations are covered. Any failure
// leaves the capability cleanly unavailable (endpoints 503) without
// affecting the rest of boot.
//
// NOTE: this runs exactly once per boot and `_available` is latched by it,
// so a permanent failure here disables prod-debug until the next deploy.
// That is why the retry above exists.
async function ensureRole(config, { admin = null } = {}) {
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    try {
      await bootstrapRole(config, admin);
      await recordBootstrap(config, { ok: true, password: _roPassword });
      return;
    } catch (err) {
      if (attempt < BOOTSTRAP_ATTEMPTS) {
        log.warn('prod-debug', 'Role bootstrap attempt failed — retrying', {
          err: err.message, attempt, attempts: BOOTSTRAP_ATTEMPTS,
        });
        // Linear backoff: 250ms, then 500ms. Long enough to outlast a
        // concurrent sweep, short enough to stay invisible in boot time.
        await sleep(BOOTSTRAP_RETRY_MS * attempt);
        continue;
      }
      _available = false;
      _unavailableReason = `prod-debug role bootstrap failed: ${err.message}`;
      _roPassword = null;
      log.warn('prod-debug', 'Role bootstrap failed — capability disabled', {
        err: err.message, attempts: BOOTSTRAP_ATTEMPTS,
      });
      await recordBootstrap(config, { ok: false, reason: _unavailableReason });
    }
  }
}

// What the migration step made, for every process (loadShared): whether the
// setup succeeded and the password, encrypted with the data key. Retried: a
// record left at the previous password refuses every process's queries until
// the next release. Never throws.
const RECORD_RETRY_MS = [500, 2000, 5000];
async function recordBootstrap(config, { ok, password = null, reason = null }) {
  let secretEnc;
  try {
    secretEnc = ok ? secrets.encrypt(password, config && config.dataEncryptionKey) : null;
  } catch (err) {
    log.warn('prod-debug', 'Could not encrypt the role\'s password for the other processes', { err: err.message });
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await getPool(config).query(
        `INSERT INTO platform_db_roles (role, ok, reason, secret_enc, release, ensured_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (role) DO UPDATE SET ok = EXCLUDED.ok, reason = EXCLUDED.reason,
           secret_enc = EXCLUDED.secret_enc, release = EXCLUDED.release, ensured_at = NOW()`,
        [ROLE, !!ok, reason, secretEnc, process.env.GIT_SHA || null]);
      return;
    } catch (err) {
      if (attempt >= RECORD_RETRY_MS.length) {
        log.warn('prod-debug', 'Could not record the role for the other processes', { err: err.message });
        return;
      }
      await sleep(RECORD_RETRY_MS[attempt]);
    }
  }
}

// A process that did not set the role up (every process: the migration
// step does, services/db-roles.js; or one whose password the next release
// rotated) uses the record. Read at most every SHARED_TTL_MS unless `force`d (a
// password Postgres refused). Never throws: a record it cannot read leaves
// the capability as it was.
async function loadShared(config, { force = false } = {}) {
  if (!force && Date.now() - _sharedReadAt < SHARED_TTL_MS) return;
  _sharedReadAt = Date.now();
  let row;
  try {
    ({ rows: [row] } = await getPool(config).query(
      'SELECT ok, reason, secret_enc FROM platform_db_roles WHERE role = $1', [ROLE]));
  } catch (err) {
    log.warn('prod-debug', 'Could not read the record of the role', { err: err.message });
    return;
  }
  if (!row) {
    _unavailableReason = 'prod-debug role not set up yet (the release\'s migration step does it)';
    return;
  }
  if (!row.ok) {
    _available = false;
    _unavailableReason = row.reason || 'prod-debug role bootstrap failed in the migration step';
    return;
  }
  const password = secrets.decrypt(row.secret_enc, config && config.dataEncryptionKey);
  if (!password) {
    _available = false;
    _unavailableReason = 'prod-debug role password could not be decrypted';
    return;
  }
  if (password !== _roPassword) {
    _roPassword = password;
    if (_roPool) {
      _roPool.end().catch(() => {});
      _roPool = null;
    }
  }
  _available = true;
  _unavailableReason = null;
}

// One bootstrap attempt. Throws on any failure so ensureRole can retry;
// sets `_available` only on the success path.
async function bootstrapRole(config, admin = null) {
  const pool = getPool(config);
  const roleAdmin = admin || pool;
  // 48 hex chars — no SQL/URL-special characters, safe to inline.
  _roPassword = crypto.randomBytes(24).toString('hex');

  await roleAdmin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${_roPassword}';
    ELSE
      ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${_roPassword}';
    END IF;
  END $$;`);
  if (admin) {
    await require('./database-role-access').assertReadonlyRole(roleAdmin, ROLE);
    await roleAdmin.query(`ALTER ROLE ${ROLE} NOCREATEDB NOCREATEROLE NOINHERIT`);
  } else {
    await pool.query(`ALTER ROLE ${ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  }
  // Role-level read-only: even a COMMIT-smuggling or multi-statement
  // query starts read-only, and the role has no write grants anyway.
  await roleAdmin.query(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
  await roleAdmin.query(`ALTER ROLE ${ROLE} SET statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);

  const { rows: dbRows } = await pool.query('SELECT current_database() AS db');
  const dbName = dbRows[0].db;
  if (!SAFE_IDENT.test(dbName)) throw new Error(`unsafe database name ${dbName}`);
  // CONNECT only — no TEMP (temp tables are a write surface).
  await pool.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM ${ROLE}`);
  await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${ROLE}`);
  await pool.query(`REVOKE CREATE ON SCHEMA public FROM ${ROLE}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);

  // PostgreSQL also clears corresponding column ACLs with this table-level
  // revoke, including grants on views and foreign tables. Reapply only the
  // reviewed base-table columns below.
  await pool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
  const { rows: tableRows } = await pool.query(
    `SELECT c.relname AS table, c.relkind AS kind,
            array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND a.attnum > 0 AND NOT a.attisdropped
      GROUP BY c.relname, c.relkind`
  );
  const grants = buildGrantStatements(tableRows);
  for (const stmt of grants) {
    await pool.query(stmt);
  }
  // No shared success record or credential is published until the effective
  // privileges and reviewed column definitions match the current policy.
  const verified = await verifyDebugRole(pool, { role: ROLE, readableColumns: READABLE_COLUMNS });

  // Rebuild the RO pool so it picks up the fresh password.
  if (_roPool) {
    _roPool.end().catch(() => {});
    _roPool = null;
  }
  _available = true;
  _unavailableReason = null;
  log.info('prod-debug', 'Read-only debug role ensured', {
    role: ROLE, db: dbName, grantedTables: grants.length,
    deniedTables: DENIED_TABLES.size,
    policyColumns: verified.columns, policyCheckMs: verified.durationMs,
    policyHash: verified.policyHash, release: process.env.GIT_SHA || null,
  });
}

function isAvailable() {
  return _available;
}

function _getRoPool(config) {
  if (_roPool) return _roPool;
  const raw = (config && config.databaseUrl) || process.env.DATABASE_URL;
  const u = new URL(raw);
  _roPool = new Pool({
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: ROLE,
    password: _roPassword,
    // One: a debug query at a time per process is plenty, and every
    // connection counts against the server's budget (item 4).
    max: 1,
    idleTimeoutMillis: 30000,
    statement_timeout: QUERY_TIMEOUT_MS,
    // Named and with a bounded wait, as every platform connection
    // (src/db/pool.js connectionOptions).
    application_name: require('../db/connection-options').connectionName('debug'),
    connectionTimeoutMillis: (config && config.dbPoolWaitMs) || 10000,
  });
  _roPool.on('error', (err) => {
    log.warn('prod-debug', 'RO pool error', { err: err.message });
  });
  return _roPool;
}

// Pure: cap a result set to MAX_ROWS rows and ~MAX_RESULT_BYTES of
// serialized JSON. Exported for unit tests.
function truncateRows(rows, { maxRows = MAX_ROWS, maxBytes = MAX_RESULT_BYTES } = {}) {
  const out = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows || []) {
    if (out.length >= maxRows) { truncated = true; break; }
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(row) || 'null');
    } catch {
      size = 64; // unserializable row — count something, keep going
    }
    if (bytes + size > maxBytes && out.length > 0) { truncated = true; break; }
    bytes += size;
    out.push(row);
  }
  return { rows: out, truncated };
}

// Execute one read-only query as the debug role. Throws with
// err.code = 'unavailable' when the role bootstrap hasn't succeeded,
// 'bad_query' for a non-string/empty query. Postgres errors (permission
// denied on a denied column, syntax errors, read-only violations) are
// passed through with their message so the agent can self-correct.
async function runQuery(sql, { config = null } = {}) {
  if (!_available) await loadShared(config);
  if (!_available) {
    const err = new Error(_unavailableReason || 'prod-debug unavailable');
    err.code = 'unavailable';
    throw err;
  }
  if (typeof sql !== 'string' || !sql.trim()) {
    const err = new Error('query must be a non-empty string');
    err.code = 'bad_query';
    throw err;
  }
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await _getRoPool(config).query(sql);
      break;
    } catch (err) {
      // 28P01: the password was rotated by a newer release's setup. Its
      // record has the new one; ask once more with it.
      if (err.code !== '28P01' || attempt > 1) throw err;
      const before = _roPassword;
      await loadShared(config, { force: true });
      if (!_available || _roPassword === before) throw err;
    }
  }
  // Multi-statement strings resolve to an array of results; report the
  // last one (writes are impossible regardless — see role setup).
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  const { rows, truncated } = truncateRows((last && last.rows) || []);
  return {
    rows,
    rowCount: (last && typeof last.rowCount === 'number') ? last.rowCount : rows.length,
    truncated,
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────

// A session qualifies for prod-debug when its app is the self-edit app
// (apps.self_hosted = TRUE) AND its OWNER is currently an admin. Checked
// fresh from the DB — both at dispatch time (env injection) and on every
// internal-API request (requireProdDebug) — so revoking admin cuts access
// immediately despite the JWT's 24h TTL. View-only admins
// (admin_readonly = TRUE) qualify: the surface is read-only, matching
// their tier.
async function checkSessionEligibility(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT a.self_hosted, u.is_admin, cs.user_id
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) return { found: false, eligible: false };
  return {
    found: true,
    eligible: !!rows[0].self_hosted && !!rows[0].is_admin,
    selfHosted: !!rows[0].self_hosted,
    isAdmin: !!rows[0].is_admin,
    ownerId: rows[0].user_id,
  };
}

async function isEligible(pool, sessionId) {
  const check = await checkSessionEligibility(pool, sessionId);
  return check.eligible;
}

// ── Prompt exposure ─────────────────────────────────────────────────────

// Injected into build + scout prompts ONLY when the turn is eligible, so
// ineligible agents never learn the capability exists.
function promptBlock() {
  return `PRODUCTION DEBUG ACCESS (admin session on the self-edit app): a read-only helper \`usernode-debug\` is available (run it via Bash) for inspecting the LIVE PRODUCTION deployment of this platform — use it to debug stuck sessions, broken apps, and failed merges from real production state instead of guessing from source:
- \`usernode-debug sql "SELECT ..."\` — run a read-only SQL query against the production platform database (its schema is this repo's \`src/db/schema.sql\`). Approved SQL columns are listed in \`READABLE_COLUMNS\` in \`src/services/debug-access.js\`. Useful starting points: \`chat_sessions\` (status and timestamps), \`merge_debug_runs\` / \`merge_debug_steps\` (merge phase/status/timing metadata), \`events\`, \`apps\`, \`llm_usage\`.
- \`usernode-debug containers\` — list runtime workloads with state and available resource information.
- \`usernode-debug logs <container> [tail]\` — recent log lines using a name returned by the inventory. Kubernetes supports managed \`sv-app-*\`, \`sv-preview-*\` and \`sv-worker-*\` workloads; Docker supports platform services and \`usernode-app-*\` / \`usernode-staging-*\` / \`usernode-worker-*\` containers. Use \`status\` for the platform's recent log events on either runtime.
- \`usernode-debug status\` — the platform health snapshot (stuck sessions, warm workers, staging, budgets) plus recent platform log events.
All output is JSON. This access is strictly READ-ONLY — writes are structurally impossible — and SQL exposes only explicitly approved operational columns. Private transcripts, workflow payloads, stream bodies and credentials are excluded at the database-grant level; do not attempt to read secrets or modify production state. Every call is audit-logged.`;
}

// Mayor-facing awareness block: appended to the Mayor system prompt
// ONLY when the session is prod-debug eligible (same gating as
// promptBlock above — ineligible Mayors must never learn the
// capability exists). Kept here beside promptBlock so the two
// capability descriptions stay in sync. Starts with the blank lines
// the prompt-assembly concatenation expects (mirrors
// getSelfHostedRefuseList in services/prompts.js).
function mayorPromptBlock() {
  return `

==== PRODUCTION DEBUG (admin session on the self-edit app) ====

This session qualifies for read-only production debugging: the session owner is an admin and this app is the platform itself. What that means for you:

- Any scout or coding agent you dispatch gets a read-only \`usernode-debug\` CLI against the LIVE PRODUCTION deployment: \`sql\` (read-only queries on the production platform database), \`containers\` (container list with memory/CPU), \`logs <container>\` (recent log lines), and \`status\` (health snapshot plus recent platform log events). When the user reports a production problem — a stuck session, a failed merge, a broken app, resource issues — your dispatch prompt SHOULD explicitly direct the agent to inspect live production state FIRST instead of guessing from source, naming the relevant starting points: \`chat_sessions\` (status and timestamps), \`merge_debug_runs\` / \`merge_debug_steps\` (merge phase/status/timing metadata), \`events\`, \`llm_usage\`, container logs.
- YOU have a \`get_prod_status\` data tool: a quick, inline production health snapshot (stuck sessions, warm workers, staging, budgets, recent platform log events). Call it to answer questions like "is anything stuck right now?" or "how's the platform doing?" directly in chat. For anything deeper — SQL queries, container logs — dispatch the scout with a prod-debug-directed prompt rather than guessing, and say that's what you're doing.
- Admin surfaces worth pointing the user at when they fit the question — all sections of the one admin console behind the header shield icon (#860): #admin/merges (step-by-step merge traces), #admin/status (the health dashboard; admins see the full view), #admin/node (node, explorer and chain services), #admin/analytics (user analytics: growth, retention and spend), #admin/estimator (progress-estimator accuracy), #admin/gallery (before/after capture screenshots), #admin/users, #admin/limits, #admin/codes.

Everything here is strictly READ-ONLY and audit-logged; SQL exposes only the operational columns listed in \`READABLE_COLUMNS\` in \`src/services/debug-access.js\`; private transcripts, workflow payloads, stream bodies and credentials are not queryable. Never present these capabilities as available to non-admins or on other apps.

==== END PRODUCTION DEBUG ====`;
}

// A draining process answers no new debug query: its pool goes (item 4: a
// draining process holds as little as it can). A query that comes anyway
// opens it again.
function closePool() {
  if (!_roPool) return;
  _roPool.end().catch(() => {});
  _roPool = null;
}

module.exports = {
  ROLE,
  ensureRole,
  closePool,
  loadShared,
  isAvailable,
  runQuery,
  checkSessionEligibility,
  isEligible,
  promptBlock,
  mayorPromptBlock,
  isAllowedLogContainer,
  clampTail,
  MAX_LOG_BYTES,
  // exported for unit tests
  buildGrantStatements,
  READABLE_COLUMNS,
  truncateRows,
  DENIED_TABLES,
  DENIED_COLUMNS,
};
