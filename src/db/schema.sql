-- Users & auth
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(255) UNIQUE NOT NULL,
  password        VARCHAR(255) NOT NULL,
  is_admin        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- #1583: account-wide, durable first-feedback acknowledgement. Historical
-- feedback was not recorded per user; existing accounts start tracking at
-- rollout. Written only after GitHub has accepted a feedback issue.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_feedback_at TIMESTAMPTZ;
-- #30: optional user-provided Anthropic API key. `anthropic_key_enc`
-- holds the encrypted payload (v1:<iv>:<tag>:<ct>, base64). We also
-- keep the last 4 chars unencrypted purely so the UI can show
-- "sk-ant-…abcd" without a decrypt round-trip.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_enc    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_last4  VARCHAR(8);

-- Per-user app-creation permission, toggled by admins from /admin.
-- Default FALSE; existing admins are backfilled to TRUE on boot.
-- Enforced server-side on POST /api/apps in src/routes/apps.js;
-- the home-screen "Create new app" affordance is hidden client-side
-- for users who fail the check (see Home.canCreate in
-- frontend/src/features/home/home.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_apps BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET can_create_apps = TRUE WHERE is_admin = TRUE AND can_create_apps = FALSE;

-- Per-user app-creation quota: the maximum number of live (non-errored)
-- apps a user may have created. This is the actual app-creation gate (see
-- src/routes/apps.js) — a non-admin may create iff their live app count is
-- below this number, so deleting an app frees a slot (mirrors the server-
-- wide maxApps cap). New accounts receive two slots. Full admins
-- bypass enforcement entirely; view-only admins keep their ordinary quota.
-- The client sees both a derived `canCreateApps` boolean (computed in auth/me
-- as canAdminWrite || liveCount < app_quota) and the numeric quota used by the
-- create dialog. `can_create_apps`
-- is KEPT for now purely as the one-shot backfill source below — dropping
-- it (and the derived canCreateApps plumbing) is deferred work.
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_quota INTEGER NOT NULL DEFAULT 2;
ALTER TABLE users ALTER COLUMN app_quota SET DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_quota_requested_at TIMESTAMPTZ;

-- is_admin is now mutable from the admin panel (grant/revoke toggle in
-- public/admin.html → POST /api/admin/users/:id/is-admin). The column is
-- nullable (DEFAULT FALSE, declared at the top of the table) so legacy
-- rows could hold NULL; normalize to FALSE so the last-admin guard's
-- `COUNT(*) WHERE is_admin = TRUE` and every `is_admin = TRUE` read treat
-- NULL and FALSE identically. Idempotent — safe to run every boot.
UPDATE users SET is_admin = FALSE WHERE is_admin IS NULL;

-- View-only admin role (issue #311). `is_admin` remains the visibility
-- tier ("can see every admin surface"); `admin_readonly` marks an admin
-- whose access is read-only — they see everything a full admin sees but
-- cannot perform any mutating/privileged action. The canonical role is
-- derived, no enum needed:
--   is_admin = FALSE                          → normal user (this column ignored)
--   is_admin = TRUE  AND admin_readonly = FALSE → full admin
--   is_admin = TRUE  AND admin_readonly = TRUE  → view-only admin
-- Auth derives `canAdminWrite = is_admin AND NOT admin_readonly` (the single
-- write gate) in src/middleware/auth.js; every read/visibility gate keeps
-- keying off is_admin unchanged. Backfill is automatic — existing admin rows
-- default to FALSE (stay full admins). NOT tagged staging:private below
-- (non-sensitive, like is_admin) so staging shows correct roles. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_readonly BOOLEAN NOT NULL DEFAULT FALSE;

-- Usernode wallet linking: pubkey is the on-chain identity once linked;
-- token + expiry gate the QR-based linking flow.
ALTER TABLE users ADD COLUMN IF NOT EXISTS usernode_pubkey          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_token        VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_expires_at   TIMESTAMPTZ;

-- Per-user override of the platform-wide daily LLM spend cap. NULL means
-- "use the global default" stored in platform_settings.user_daily_limit_cents
-- (see below). Set by admins from /admin to grant trusted users a higher
-- cap without raising it for everyone. Read by checkBudget() in
-- src/routes/sessions.js via src/services/limits.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_limit_cents INTEGER;

-- #1788: per-user WEEKLY LLM spend cap in cents, layered on top of the
-- daily one above. NULL means "use the platform default" stored in
-- platform_settings.user_weekly_limit_cents (see below); 0 means "no
-- weekly cap applies to this user". Same admin surfaces as the daily
-- override (/api/admin/users/:id/weekly-limit, admin console → Users).
-- Read by limits.getUserCreditEntitlement / limits.resolveCaps, which
-- own the full daily-vs-weekly interaction.
ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_limit_cents INTEGER;

-- Experimental: opt-in AI progress estimate for coding runs. When TRUE,
-- the platform periodically asks Haiku to skim the in-flight Claude Code
-- progress log and emits a vague "AI guess" line in dev-chat (see
-- runClaudeCodeTool in src/routes/sessions.js). Default OFF for everyone
-- while the experiment runs; toggled from Settings → Experimental via
-- POST /api/me/ai-progress-estimate.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_progress_estimate BOOLEAN NOT NULL DEFAULT FALSE;

-- #1281: the session-CLI bridge is opt-in, per user.
--
-- The spec marks the bridge SETTINGS-GATED and "most users: no" — it is the
-- platform dev-chat UX driven from your own machine, and it wants the
-- Usernode CLI installed and attached before it does anything at all.
-- Until now the only gate was the DEPLOYMENT's cliAuthEnabled, so the venue
-- was offered to everyone on a deployment that merely supports the CLI.
-- Default FALSE, deliberately: an option nobody has asked for should not be
-- in a list everybody reads, and this one is bottom of the spec's routing
-- tree for that exact reason. Settings -> Developer -> Experimental turns
-- it on; the deployment gate still applies on top.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_bridge_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Home sections are permanent (#1801). Remove the obsolete preference from
-- existing databases; IF EXISTS also makes fresh installs and repeat boots safe.
ALTER TABLE users DROP COLUMN IF EXISTS home_panels_hidden;

-- RETIRED — superseded by the `user_home_layout` table (free-form home-grid
-- placement). It used to hold an iOS-homescreen-style drag position per
-- panel key ({ "challenges": 4 } = four app cards above the block), which
-- only ever expressed "which flow slot" — the home grid now stores real
-- (column, row) cells per breakpoint instead, and holes are a first-class
-- concept a card-count can't represent.
--
-- This separate legacy placement field is left in place, unread and
-- unwritten. Nothing may read it — see user_home_layout below.
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_panel_positions JSONB NOT NULL DEFAULT '{}';

-- Platform-level user language preference (issue #757). A BCP-47 language
-- tag ("id", "pt-BR", …) or NULL for "unset/auto — use device language".
-- Set from Settings → Language via POST /api/me/locale; exposed to apps as
-- the `locale` claim in the iframe JWT (server.js /api/iframe-token) and
-- through /api/auth/me → the shell → the bridge's usernode.getUserLocale().
-- 35 chars is the RFC 5646 recommended buffer for BCP-47 tags.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(35);

-- Preferred development flow (issue #1049). NULL = "ask me every time", the
-- default: the dev-chat picker renders and the user chooses per proposal.
-- A non-NULL value is the "remember my option" checkbox — 'platform' builds
-- here with the platform's own agent, 'claude-code' / 'codex' hand the work
-- order to the user's own Claude Code / Codex web UI (the external-agent
-- flow in services/external-agent-tasks.js).
--
-- No longer read or written (#4311): POST /api/me/dev-flow, the
-- `devFlowPreference` field of GET /api/auth/me and the Settings row were
-- removed because nothing chose a venue from the value. The column and its
-- CHECK stay so a rollback to an older build still finds them; drop them in
-- a later migration once no deployable build reads them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dev_flow_preference TEXT;
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_dev_flow_preference_chk;
  ALTER TABLE users ADD CONSTRAINT users_dev_flow_preference_chk
    CHECK (dev_flow_preference IS NULL
           OR dev_flow_preference IN ('platform', 'claude-code', 'codex'));
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- A renewable browser session still needs a fixed birthday. `expires_at`
-- slides on authenticated use; `created_at` is the anchor for the absolute
-- lifetime cap that prevents an actively replayed stolen cookie living
-- forever. Existing rows are dated from this migration, which can only make
-- their cap earlier than guessing an older creation time would.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Narrow, HttpOnly-cookie-backed continuation between a successful email
-- code and first-password setup. This is deliberately not a mobile bearer:
-- it authorizes exactly one password setup, is stored only as a hash, and is
-- consumed in the same transaction that creates the ordinary web session.
CREATE TABLE IF NOT EXISTS web_signup_sessions (
  token_hash  VARCHAR(64) PRIMARY KEY
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_web_signup_sessions_expires
  ON web_signup_sessions (expires_at);
COMMENT ON TABLE web_signup_sessions IS 'staging:private';

-- Sign in with Apple and Google (src/services/sign-in-providers.js). Set up
-- by an admin in Admin → Sign-in providers, one row per provider, and offered
-- on the sign-in sheet only once a row is complete and switched on.
-- `secret_enc` is Google's client secret or Apple's .p8 private key,
-- encrypted with the data key (services/secrets.js). Private to staging: a
-- preview never has a provider set up, and the data key it runs with could
-- not read production's ciphertext anyway.
CREATE TABLE IF NOT EXISTS sign_in_providers (
  provider    TEXT PRIMARY KEY CHECK (provider IN ('apple', 'google')),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  client_id   TEXT CHECK (client_id IS NULL OR char_length(client_id) BETWEEN 1 AND 200),
  team_id     TEXT CHECK (team_id IS NULL OR team_id ~ '^[A-Z0-9]{10}$'),
  key_id      TEXT CHECK (key_id IS NULL OR key_id ~ '^[A-Z0-9]{10}$'),
  secret_enc  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE sign_in_providers IS 'staging:private';
COMMENT ON COLUMN sign_in_providers.secret_enc IS 'staging:private';
-- Native sign-in, in the Homeroom app's own Apple and Google sheets: the
-- app's client IDs, which its ID tokens carry as their audience. Apple: the
-- app's bundle ID. Google: the iOS client ID (an Android token carries the
-- web client ID, `client_id`). Empty means the app does not offer it.
ALTER TABLE sign_in_providers ADD COLUMN IF NOT EXISTS app_client_ids TEXT[] NOT NULL DEFAULT '{}';

-- An account's Apple or Google identity: the provider's stable subject, so
-- the next sign-in finds the account even if the address on it changed.
-- The first sign-in links by verified address, or makes the account.
CREATE TABLE IF NOT EXISTS user_oauth_identities (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  subject      TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
);
COMMENT ON TABLE user_oauth_identities IS 'staging:private';

-- One provider round trip, from the sheet's button to the callback: single
-- use, ten minutes, stored only as hashes. `binder_hash` ties it to the
-- browser that started it (an HttpOnly cookie), so a callback replayed into
-- somebody else's browser signs nobody in there. `follow_invite` and
-- `started_from` are what the sheet knew, carried across the trip.
CREATE TABLE IF NOT EXISTS oauth_sign_in_states (
  state_hash    VARCHAR(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  provider      TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  binder_hash   VARCHAR(64) NOT NULL CHECK (binder_hash ~ '^[0-9a-f]{64}$'),
  nonce         TEXT NOT NULL,
  code_verifier TEXT,
  follow_invite BOOLEAN NOT NULL DEFAULT FALSE,
  started_from  TEXT,
  return_to     TEXT NOT NULL DEFAULT '/',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_sign_in_states_expires
  ON oauth_sign_in_states (expires_at);
COMMENT ON TABLE oauth_sign_in_states IS 'staging:private';
COMMENT ON COLUMN oauth_sign_in_states.nonce IS 'staging:private';
COMMENT ON COLUMN oauth_sign_in_states.code_verifier IS 'staging:private';
-- A native sign-in's state: started by the page, finished by the ID token
-- the app's own sheet returned. Neither kind is spent by the other's route.
ALTER TABLE oauth_sign_in_states ADD COLUMN IF NOT EXISTS native BOOLEAN NOT NULL DEFAULT FALSE;

-- A native sign-in's ID token is spent once: its hash, kept until the
-- token itself expires.
CREATE TABLE IF NOT EXISTS native_sign_in_tokens (
  token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  provider   TEXT NOT NULL CHECK (provider IN ('apple', 'google')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_sign_in_tokens_expires
  ON native_sign_in_tokens (expires_at);
COMMENT ON TABLE native_sign_in_tokens IS 'staging:private';

-- The username step after a provider sign-in made (or found) an account that
-- has never chosen a handle: the web_signup_sessions shape, for a step that
-- sets no password. Consumed in the transaction that mints the session.
CREATE TABLE IF NOT EXISTS oauth_signup_sessions (
  token_hash  VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'phone')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oauth_signup_sessions_expires
  ON oauth_signup_sessions (expires_at);
COMMENT ON TABLE oauth_signup_sessions IS 'staging:private';

-- Phone sign-in rides the same username continuation as Apple and Google
-- (services/firebase-phone-auth.js). The constraint is named, dropped and
-- re-added so an existing database widens idempotently; a fresh install
-- above already carries all three values, so the re-add renames only.
ALTER TABLE oauth_signup_sessions
  DROP CONSTRAINT IF EXISTS oauth_signup_sessions_provider_check;
ALTER TABLE oauth_signup_sessions
  ADD CONSTRAINT oauth_signup_sessions_provider_check
  CHECK (provider IN ('apple', 'google', 'phone'));

-- A phone identity, beside Apple and Google (user_oauth_identities) rather
-- than inside their OAuth contract: its invariants are its own (one account
-- per number, one identity per account, E.164 shape), and the number is
-- PII, so this table is private like its sibling. firebase_uid is the
-- stable subject the next sign-in finds; the number is the human-facing
-- key. Nothing on the platform derives an account from the number — the
-- number is how the person proves themselves to Firebase, not how we look
-- them up.
CREATE TABLE IF NOT EXISTS user_phone_identities (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  firebase_uid TEXT NOT NULL UNIQUE CHECK (char_length(firebase_uid) BETWEEN 1 AND 128),
  phone_e164   VARCHAR(16) NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_phone_identities_user
  ON user_phone_identities (user_id);
COMMENT ON TABLE user_phone_identities IS 'staging:private';

-- A phone sign-in's ID token is spent once: its hash, kept until the token
-- itself expires. Same rule as native_sign_in_tokens above.
CREATE TABLE IF NOT EXISTS phone_sign_in_tokens (
  token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_sign_in_tokens_expires
  ON phone_sign_in_tokens (expires_at);
COMMENT ON TABLE phone_sign_in_tokens IS 'staging:private';

-- One row per failed phone linking/verification attempt (routes/phone-auth.js
-- fail(), services/phone-failure-log.js): what was attempted (kind), whose
-- account it was (null before a sign-in exists, and for the code-request
-- legs), Firebase's own code beside this API's mapped one, and the message
-- the caller saw. The number is kept as its last four digits only — enough
-- to tell attempts apart, without a second copy of the PII its identity
-- table already holds. Read by Admin → SMS delivery
-- (routes/admin.js GET /api/admin/sms/failures); reaped by
-- firebase-phone-auth.js cleanupExpired after 30 days.
CREATE TABLE IF NOT EXISTS phone_auth_failures (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('code_request', 'verify', 'link_request', 'link_verify')),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone_last4   VARCHAR(4) CHECK (phone_last4 ~ '^[0-9]{4}$'),
  error_code    TEXT NOT NULL,
  provider_code TEXT,
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_auth_failures_created
  ON phone_auth_failures (created_at DESC);
COMMENT ON TABLE phone_auth_failures IS 'staging:private';

-- Global CLI device authorization and opaque access tokens. These are
-- deliberately independent from browser sessions and iframe/app identity.
CREATE TABLE IF NOT EXISTS cli_device_authorizations (
  id BIGSERIAL PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE
    CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code TEXT NOT NULL UNIQUE
    CHECK (
      user_code = UPPER(user_code)
      AND user_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'
    ),
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_device_authorizations_scopes_check
    CHECK (
      scopes = ARRAY['rpc:identity:read']::TEXT[]
      OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
      OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
    ),
  request_ip INET NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'consumed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
    CHECK (expires_at = created_at + INTERVAL '10 minutes'),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  CHECK (
    (status = 'pending' AND user_id IS NULL
      AND approved_at IS NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'approved' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'rejected' AND user_id IS NOT NULL
      AND approved_at IS NULL AND rejected_at IS NOT NULL
      AND cancelled_at IS NULL AND consumed_at IS NULL)
    OR
    (status = 'cancelled' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NOT NULL AND consumed_at IS NULL)
    OR
    (status = 'consumed' AND user_id IS NOT NULL
      AND approved_at IS NOT NULL AND rejected_at IS NULL
      AND cancelled_at IS NULL AND consumed_at IS NOT NULL)
  ),
  CHECK (approved_at IS NULL OR approved_at >= created_at),
  CHECK (rejected_at IS NULL OR rejected_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= approved_at),
  CHECK (consumed_at IS NULL OR consumed_at >= approved_at),
  CHECK (approved_at IS NULL OR approved_at < expires_at),
  CHECK (rejected_at IS NULL OR rejected_at < expires_at),
  CHECK (cancelled_at IS NULL OR cancelled_at < expires_at),
  CHECK (consumed_at IS NULL OR consumed_at < expires_at),
  CHECK (
    (last_polled_at IS NULL AND poll_count = 0)
    OR
    (last_polled_at IS NOT NULL
      AND last_polled_at >= created_at
      AND poll_count > 0)
  )
);

CREATE TABLE IF NOT EXISTS cli_access_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL
    CHECK (token_hint ~ '^svcli_…[A-Za-z0-9_-]{4}$'),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_access_tokens_scopes_check
    CHECK (
      cardinality(scopes) <= 3
      AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at = created_at + INTERVAL '30 days'),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE IF NOT EXISTS cli_auth_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'authorization_started', 'authorization_approved',
      'authorization_rejected', 'authorization_cancelled',
      'token_issued', 'token_used', 'token_revoked'
    )),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_authorization_id BIGINT,
  access_token_id BIGINT,
  client_id TEXT NOT NULL DEFAULT 'social-vibecoding-cli'
    CHECK (client_id = 'social-vibecoding-cli'),
  scopes TEXT[] NOT NULL
    CONSTRAINT cli_auth_audit_events_scopes_check
    CHECK (
      (event_type IN ('token_used', 'token_revoked')
       AND cardinality(scopes) <= 3
       AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[])
      OR
      (event_type NOT IN ('token_used', 'token_revoked')
       AND (
         scopes = ARRAY['rpc:identity:read']::TEXT[]
         OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
         OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
       ))
    ),
  outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (
      (event_type = 'token_used'
       AND outcome IN ('scope_authorized', 'insufficient_scope'))
      OR (event_type <> 'token_used' AND outcome = 'success')
    ),
  metadata JSONB NOT NULL DEFAULT '{}'
    CONSTRAINT cli_auth_audit_events_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT cli_auth_audit_events_metadata_allowlist_check
    CHECK (
      (
        event_type = 'token_used'
        AND metadata ? 'method'
        AND metadata ? 'route'
        AND metadata - ARRAY['method', 'route']::TEXT[] = '{}'::JSONB
        AND jsonb_typeof(metadata->'method') = 'string'
        AND metadata->>'method' IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
        AND jsonb_typeof(metadata->'route') = 'string'
        AND char_length(metadata->>'route') BETWEEN 1 AND 2048
        AND metadata->>'route' LIKE '/api/%'
      )
      OR (
        event_type = 'authorization_cancelled'
        AND metadata = '{"reason":"account_recovery"}'::JSONB
      )
      OR (
        event_type = 'token_revoked'
        AND metadata ? 'reason'
        AND jsonb_typeof(metadata->'reason') = 'string'
        AND metadata->>'reason' IN ('self', 'settings', 'account_recovery')
        AND metadata - 'reason' = '{}'::JSONB
      )
      OR (
        event_type NOT IN (
          'token_used', 'authorization_cancelled', 'token_revoked'
        )
        AND metadata = '{}'::JSONB
      )
    ),
  CHECK (
    (event_type IN (
      'authorization_started', 'authorization_approved',
      'authorization_rejected', 'authorization_cancelled'
    ) AND device_authorization_id IS NOT NULL)
    OR
    (event_type = 'token_issued'
      AND device_authorization_id IS NOT NULL
      AND access_token_id IS NOT NULL)
    OR
    (event_type IN ('token_used', 'token_revoked')
      AND access_token_id IS NOT NULL)
  )
);

-- Expand the CLI grant from identity-only to the authenticated user-facing
-- JSON API.
-- Existing identity-only rows remain valid until they expire or are revoked;
-- all newly-created device grants request the exact two-scope set.
DO $$
DECLARE
  constraint_name TEXT;
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_device_authorizations'::regclass
     AND conname = 'cli_device_authorizations_scopes_check';
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    ALTER TABLE cli_device_authorizations
      DROP CONSTRAINT cli_device_authorizations_scopes_check;
    ALTER TABLE cli_device_authorizations
      ADD CONSTRAINT cli_device_authorizations_scopes_check CHECK (
        scopes = ARRAY['rpc:identity:read']::TEXT[]
        OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
        OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
      );
  END IF;

  SELECT pg_get_constraintdef(oid) INTO constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_access_tokens'::regclass
     AND conname = 'cli_access_tokens_scopes_check';
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    ALTER TABLE cli_access_tokens
      DROP CONSTRAINT cli_access_tokens_scopes_check;
    ALTER TABLE cli_access_tokens
      ADD CONSTRAINT cli_access_tokens_scopes_check CHECK (
        cardinality(scopes) <= 3
        AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
      );
  END IF;

  -- This table's original multi-column inline CHECK was auto-named
  -- cli_auth_audit_events_check rather than ..._scopes_check. Discover it
  -- by the protected column so deployed databases migrate regardless of
  -- PostgreSQL's generated name; new databases use the explicit name above.
  SELECT conname, pg_get_constraintdef(oid)
    INTO constraint_name, constraint_def
    FROM pg_constraint
   WHERE conrelid = 'cli_auth_audit_events'::regclass
     AND contype = 'c'
     AND position('scopes' IN pg_get_constraintdef(oid)) > 0
   ORDER BY oid
   LIMIT 1;
  IF constraint_def IS NOT NULL
      AND position('agent:local' IN constraint_def) = 0 THEN
    EXECUTE format(
      'ALTER TABLE cli_auth_audit_events DROP CONSTRAINT %I',
      constraint_name
    );
    ALTER TABLE cli_auth_audit_events
      ADD CONSTRAINT cli_auth_audit_events_scopes_check CHECK (
        (event_type IN ('token_used', 'token_revoked')
         AND cardinality(scopes) <= 3
         AND scopes <@ ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[])
        OR
        (event_type NOT IN ('token_used', 'token_revoked')
         AND (
           scopes = ARRAY['rpc:identity:read']::TEXT[]
           OR scopes = ARRAY['rpc:identity:read', 'api:access']::TEXT[]
           OR scopes = ARRAY['rpc:identity:read', 'api:access', 'agent:local']::TEXT[]
         ))
      );
  END IF;
END $$;

-- CREATE TABLE does not add new constraints to an existing deployment.
-- Install the exact audit-metadata allowlist when upgrading an older schema.
DO $$
DECLARE
  constraint_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO constraint_def
      FROM pg_constraint
     WHERE conrelid = 'cli_auth_audit_events'::regclass
       AND conname = 'cli_auth_audit_events_metadata_allowlist_check';
  IF constraint_def IS NOT NULL
      AND (
        position('metadata ? ''reason''' IN constraint_def) = 0
        OR position('''POST''' IN constraint_def) = 0
        OR position('''PUT''' IN constraint_def) = 0
        OR position('''PATCH''' IN constraint_def) = 0
        OR position('''DELETE''' IN constraint_def) = 0
        OR position('''/api/%''' IN constraint_def) = 0
      ) THEN
    ALTER TABLE cli_auth_audit_events
      DROP CONSTRAINT cli_auth_audit_events_metadata_allowlist_check;
    constraint_def := NULL;
  END IF;
  IF constraint_def IS NULL THEN
    ALTER TABLE cli_auth_audit_events
      ADD CONSTRAINT cli_auth_audit_events_metadata_allowlist_check
      CHECK (
        (
          event_type = 'token_used'
          AND metadata ? 'method'
          AND metadata ? 'route'
          AND metadata - ARRAY['method', 'route']::TEXT[] = '{}'::JSONB
          AND jsonb_typeof(metadata->'method') = 'string'
          AND metadata->>'method' IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
          AND jsonb_typeof(metadata->'route') = 'string'
          AND char_length(metadata->>'route') BETWEEN 1 AND 2048
          AND metadata->>'route' LIKE '/api/%'
        )
        OR (
          event_type = 'authorization_cancelled'
          AND metadata = '{"reason":"account_recovery"}'::JSONB
        )
        OR (
          event_type = 'token_revoked'
          AND metadata ? 'reason'
          AND jsonb_typeof(metadata->'reason') = 'string'
          AND metadata->>'reason' IN ('self', 'settings', 'account_recovery')
          AND metadata - 'reason' = '{}'::JSONB
        )
        OR (
          event_type NOT IN (
            'token_used', 'authorization_cancelled', 'token_revoked'
          )
          AND metadata = '{}'::JSONB
        )
      );
  END IF;
END $$;

-- Shared token-bucket state. Keys are fixed SHA-256 digests of a
-- namespace and subject, never raw credentials or addresses.
CREATE TABLE IF NOT EXISTS cli_auth_rate_limits (
  bucket_key TEXT PRIMARY KEY CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  tokens DOUBLE PRECISION NOT NULL CHECK (tokens >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS cli_device_authorizations_expiry_idx
  ON cli_device_authorizations (expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_ip_state_idx
  ON cli_device_authorizations (request_ip, status, expires_at);
CREATE INDEX IF NOT EXISTS cli_device_authorizations_state_expiry_idx
  ON cli_device_authorizations (status, expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_user_idx
  ON cli_access_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cli_access_tokens_expiry_idx
  ON cli_access_tokens (expires_at);
CREATE INDEX IF NOT EXISTS cli_access_tokens_revoked_idx
  ON cli_access_tokens (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_time_idx
  ON cli_auth_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_user_idx
  ON cli_auth_audit_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cli_auth_audit_events_actor_idx
  ON cli_auth_audit_events (actor_user_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_device_transition_uidx
  ON cli_auth_audit_events (event_type, device_authorization_id)
  WHERE event_type IN (
    'authorization_started', 'authorization_approved',
    'authorization_rejected', 'authorization_cancelled'
  );
CREATE UNIQUE INDEX IF NOT EXISTS cli_auth_audit_token_transition_uidx
  ON cli_auth_audit_events (event_type, access_token_id)
  WHERE event_type IN ('token_issued', 'token_revoked');
CREATE INDEX IF NOT EXISTS cli_auth_rate_limits_expiry_idx
  ON cli_auth_rate_limits (expires_at);

COMMENT ON TABLE cli_device_authorizations IS 'staging:private';
COMMENT ON TABLE cli_access_tokens IS 'staging:private';
COMMENT ON TABLE cli_auth_audit_events IS 'staging:private';
COMMENT ON TABLE cli_auth_rate_limits IS 'staging:private';

CREATE TABLE IF NOT EXISTS activation_codes (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(32) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);

-- Apps. `retry_count` tracks how many times creation has been retried
-- after a failure (see src/routes/apps.js retry endpoint).
CREATE TABLE IF NOT EXISTS apps (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  slug           VARCHAR(255) UNIQUE NOT NULL,
  repo_url       VARCHAR(512),
  container_id   VARCHAR(128),
  status         VARCHAR(32) NOT NULL DEFAULT 'creating',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
-- #21: surface the currently deployed commit. `main_sha` is the SHA the
-- prod container was built from; `main_pr_number` is the PR that
-- produced it (null for the initial pre-merge build). Backfilled on
-- server boot for apps created before this migration.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_sha VARCHAR(40);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_pr_number INTEGER;
-- Surface "when the app was last code-updated" on the home cards
-- alongside created_at. Bumped to NOW() at every successful prod-
-- container rebuild — the four sites in app-creator.js (initial
-- deploy), routes/apps.js (/redeploy), routes/votes.js (vote-merge),
-- and the governance machine (a secret change's rebuild). Backfilled to
-- created_at for existing rows on first boot so the home tile reads
-- "updated <created_at>" instead of "never" for pre-migration apps;
-- the IS NULL guard makes the backfill a one-shot.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_deploy_at TIMESTAMPTZ;
UPDATE apps SET last_deploy_at = created_at WHERE last_deploy_at IS NULL;
-- When the project first ran: set once, by the first successful deploy in
-- services/app-creator.js (services/journey-events.js markFirstRunning),
-- beside an `app_running` event. last_deploy_at cannot answer it, since
-- every merge moves it. NULL for a project that never ran, and for every
-- project from before this column: it is not backfilled, because nothing
-- recorded the moment (the admin Journey's creation path says so).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS first_running_at TIMESTAMPTZ;
-- Snapshot of `dapp.json` from the last successful clone (createApp +
-- deployProduction both write it). The Secrets UI reads this so it
-- can render the manifest-declared keys without re-cloning, and the
-- deploy block-on-missing-required check uses it as the source of
-- truth for "what does this dapp create".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS manifest_snapshot JSONB;

-- #416: detail of the last build/deploy failure so the UI can show a
-- build log instead of a bare "Error" status. Shape:
--   { stage, reason, log, at, sha }
--   stage  : 'database'|'repo'|'clone'|'build'|'start'|'healthcheck'|'timeout'|'other'
--   reason : concise human line (<= 280 chars)
--   log    : ANSI-stripped tail of the docker build / boot output (<= 16 kB)
--   interrupted : true on a creation the platform's restarts ended, whose
--            Retry is not counted against the creator
-- Written by the deploy catch paths (services/app-creator.js,
-- services/staging.js deployProduction, the creation watchdog in
-- services/app-creation-owner.js);
-- cleared (NULL) on every successful deploy. Exposed API-side only to
-- the app's creator / collaborators / admins — see routes/apps.js.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_failure JSONB;

-- Who is setting a project up, so a platform restart cannot lose it
-- (services/app-creation-owner.js). Creation runs for minutes after the
-- request that started it has answered, in whichever process served it, and
-- dies with that process. `creating_owner` is the token of the attempt
-- driving the row and `creating_heartbeat_at` when it last said so (every
-- 20 seconds while it runs); both NULL once it ends. The leader resumes a
-- 'creating' row whose owner went quiet, by running the same idempotent
-- create path again under a new token, at most three times an attempt
-- (`creating_redrives`, back to 0 when a person starts a new attempt), and
-- only then flips it to 'error'. A row whose owner is alive is never swept,
-- and Retry takes the row only from nobody, or from an owner gone quiet.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS creating_owner TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS creating_heartbeat_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS creating_redrives INTEGER NOT NULL DEFAULT 0;
-- Retired: a production redeploy the old governance paths owed an app (the
-- deleted services/owed-redeploy.js). Every deploy is app-delivery's request.
ALTER TABLE apps DROP COLUMN IF EXISTS redeploy_owed_at;
ALTER TABLE apps DROP COLUMN IF EXISTS redeploy_owed_reason;
ALTER TABLE apps DROP COLUMN IF EXISTS redeploy_owner;
ALTER TABLE apps DROP COLUMN IF EXISTS redeploy_heartbeat_at;
ALTER TABLE apps DROP COLUMN IF EXISTS redeploy_kicks;

-- Admin-gated change lock. When TRUE, applying any group-voted change to
-- this app (PR merge in routes/votes.js, a governance proposal in the
-- governance machine, src/workflow/governance-proposal/) additionally requires at least one admin
-- "yes"/"up" vote on top of the existing active-user majority. Toggled by
-- admins via POST /api/apps/:slug/lock; the home-card lock icon (admin-
-- only) is the canonical UI affordance. Default FALSE so every existing
-- app starts unlocked and behaves exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-app postgres role password. Every app's database has a dedicated
-- postgres role `<dbName>_owner` with this random password; the app's
-- container connects with that role's URL instead of the shared
-- superuser. Compromise of one app's DATABASE_URL no longer authorizes
-- access to other apps' DBs in the cluster. NULL means the app
-- predates the per-role migration; src/db/migrate.js's
-- migrateAppDbsToPerRole adopts such DBs at boot and persists the
-- password here. See src/services/db-manager.js for the role-creation
-- and reassignment logic. Tagged `staging:private` so the existing
-- column-scrub mechanism in cloneDatabase blanks it in any clone — a
-- staging container reading this from its cloned `apps` table would
-- get NULL for every row, which is correct (the staging container
-- has no business connecting to other prod app DBs).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_password TEXT;
-- Runtime-neutral deployment references. Docker's historical container_id
-- stays populated in Docker mode; Kubernetes mode records the image digest,
-- immutable kpack Build and namespaced workload separately.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS image_ref TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS build_ref VARCHAR(253);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS runtime_kind VARCHAR(32) NOT NULL DEFAULT 'docker';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS runtime_name VARCHAR(253);

-- Activity tracking (for home screen sort)
CREATE TABLE IF NOT EXISTS app_activity (
  id             SERIAL PRIMARY KEY,
  app_id         INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  seconds_spent  INTEGER NOT NULL DEFAULT 0,
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(app_id, user_id, date)
);
ALTER TABLE app_activity ADD COLUMN IF NOT EXISTS precise_milliseconds BIGINT NOT NULL DEFAULT 0;

-- Delivery receipts for engaged-use batches. A browser retains the same UUID
-- until acknowledgement, so a response lost after COMMIT can be retried
-- without adding its seconds twice. The payload hash also prevents a caller
-- from reusing a receipt for different data. Receipts contain user-level
-- analytics delivery history and therefore do not copy into staging.
CREATE TABLE IF NOT EXISTS app_activity_receipts (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL,
  payload_sha256  CHAR(64) NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_app_activity_receipts_received
  ON app_activity_receipts(received_at);
COMMENT ON TABLE app_activity_receipts IS 'staging:private';

-- The occurrence intervals behind the daily totals. Kept for challenge
-- scoring after a delivery receipt expires; their timestamps are never the
-- upload or scoring time. A receipt and all its intervals commit together.
CREATE TABLE IF NOT EXISTS app_usage_intervals (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL,
  interval_index  INTEGER NOT NULL,
  date            DATE NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  CHECK (ended_at > started_at),
  UNIQUE (user_id, batch_id, interval_index)
);
CREATE INDEX IF NOT EXISTS idx_app_usage_intervals_user_app_time
  ON app_usage_intervals (user_id, app_id, started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_app_usage_intervals_day
  ON app_usage_intervals (user_id, app_id, date);
COMMENT ON TABLE app_usage_intervals IS 'staging:private';

-- Per-check history: which of an app's declared dapp.json checks have ever
-- been OBSERVED PASSING, and are therefore allowed to block a merge.
--
-- Background: the manifest reader used to keep only the first 12 declared
-- checks, so this repo's own ~229 tail checks had never executed once. The
-- capture container now runs every declared check on every build, and this
-- table is what stops that from blocking the next proposal on hundreds of
-- pre-existing failures it did not cause. A check is BLOCKING iff
-- `first_passed_at IS NOT NULL` (derived, never stored as a flag); one that
-- has never passed is ADVISORY — it runs and reports, but does not gate.
-- There is no demotion: a graduated check that starts failing stays
-- blocking, which is the whole point of graduating it.
--
-- `check_key` is sha256(name || '\n' || path) — the same (name+path) pair
-- app-manifest.readTests de-duplicates on, so renaming a check mints a new
-- key and drops it back to advisory (an edited check re-earns its status).
--
-- PUBLIC (no `staging:private` tag) and deliberately so: it holds check
-- names and pass/fail timestamps for app code, which every viewer of a
-- proposal's checks card can already see. No credentials, no user content.
CREATE TABLE IF NOT EXISTS app_check_history (
  id              BIGSERIAL PRIMARY KEY,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  check_key       VARCHAR(64) NOT NULL,
  check_name      TEXT,
  check_path      TEXT,
  first_passed_at TIMESTAMPTZ,
  last_passed_at  TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pass_count      INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_app_check_history_app ON app_check_history(app_id);

-- `consecutive_passes` is what graduation reads now. ONE observed pass used
-- to be enough, so a check that is flaky from birth graduated on its first
-- lucky run and blocked every proposal afterwards, with no demotion to
-- undo it. Ten in a row, reset to zero by any failure, is a bar a 1-in-20
-- flake clears only 60% of the time per window instead of 95%.
--
-- The backfill is a genuine one-time migration written to be safe under
-- the idempotent boot: the column is added NULLABLE with no default, the
-- two UPDATEs give every pre-existing row a value, and recordRun always
-- writes one explicitly. On the second boot nothing is NULL, so both
-- UPDATEs match nothing. A default would have re-run on every boot and
-- re-graduated any check whose counter a failure had just reset.
ALTER TABLE app_check_history ADD COLUMN IF NOT EXISTS consecutive_passes INTEGER;
-- Already gating under the one-pass rule: keep it gating. No guard rail
-- this app relies on is demoted by raising the bar.
UPDATE app_check_history SET consecutive_passes = 10
  WHERE consecutive_passes IS NULL AND first_passed_at IS NOT NULL;
UPDATE app_check_history SET consecutive_passes = 0 WHERE consecutive_passes IS NULL;

-- The graduated-set load is the hot read (once per checks run).
CREATE INDEX IF NOT EXISTS idx_app_check_history_graduated
  ON app_check_history(app_id) WHERE first_passed_at IS NOT NULL;

-- A check blocks every proposal once it has passed on a proposal that
-- MERGED, not on its first pass anywhere (services/check-history.js). On
-- 9 Oct 2026 the fix for the Custom domain check (#4576) passed it on its
-- own preview, and that pass made the check block about fifteen other
-- proposals, none of which contained the fix, for the hour it waited for a
-- vote.
--
--   merged_pass_at     when a merged proposal that had passed it was folded
--                      in (settleMergedPasses), or the bootstrap's moment.
--                      What the graduated set reads.
--   merged_pass_known  TRUE on every row recordRun or the bootstrap writes.
--                      NULL only on a row from before this column, which the
--                      one-time backfill below gives its first pass as its
--                      merged pass, so nothing gating today stops gating.
--
-- The backfill is one-time the way consecutive_passes' is: it matches only
-- rows whose marker is NULL and gives each a value, and every later write
-- sets the marker, so on the next boot it matches nothing.
ALTER TABLE app_check_history ADD COLUMN IF NOT EXISTS merged_pass_at TIMESTAMPTZ;
ALTER TABLE app_check_history ADD COLUMN IF NOT EXISTS merged_pass_known BOOLEAN;
UPDATE app_check_history SET merged_pass_at = first_passed_at, merged_pass_known = TRUE
  WHERE merged_pass_known IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_check_history_merged
  ON app_check_history(app_id) WHERE merged_pass_at IS NOT NULL;

-- Group chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  app_id     INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  msg_type   VARCHAR(32) NOT NULL DEFAULT 'message',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat sessions (one per branch/PR)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  branch_name          VARCHAR(255),
  pr_number            INTEGER,
  pr_url               VARCHAR(512),
  pr_title             VARCHAR(256),
  staging_container_id VARCHAR(128),
  staging_url          VARCHAR(512),
  -- Lifecycle: the proposal machine's projection (src/workflow/proposal/,
  -- the guard at the end of this file), except the move into 'merged',
  -- which is merge-followups'.
  --   'active'    = underway, holding one of its owner's slots (and the
  --                 platform's): it has, or can lazily spawn, a warm worker.
  --                 Counts against the per-user active-session cap
  --                 (MAX_USER_SESSIONS, raised for full platform admins by
  --                 MAX_ADMIN_USER_SESSIONS: src/services/session-caps.js).
  --                 An imported proposal holds no slot and reads 'active'.
  --   'paused'    = underway, its slot given back: its worker is gone, its CC
  --                 volume, branch, pull request and preview are kept.
  --   'promoted'  = up for a vote; bounded by the promoted cap
  --                 (MAX_USER_PROMOTED_SESSIONS / MAX_ADMIN_USER_PROMOTED_SESSIONS).
  --   'merging'   = claimed by a merge attempt.
  --   'merged'    = merged (merge-followups).
  --   'archived'  = closed (withdrawn, voted down, gone quiet, replaced, ...);
  --                 its pull request closed, its preview and worker gone.
  --                 Reopened as 'paused'.
  status               VARCHAR(32) NOT NULL DEFAULT 'active',
  -- Claude Code session id captured from the `init` stream-json event on the
  -- first turn of this chat. Subsequent turns pass `--resume <id>` to reuse
  -- CC's on-disk conversation memory (stored in a named Docker volume).
  cc_session_id        VARCHAR(64),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat session messages (user <-> LLM)
CREATE TABLE IF NOT EXISTS chat_session_messages (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role         VARCHAR(20) NOT NULL,
  content      TEXT NOT NULL,
  model        VARCHAR(100),
  token_count  INTEGER DEFAULT 0,
  cost_cents   NUMERIC(10,4) DEFAULT 0,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- #800: until this landed, the pkey was this table's ONLY index — while
-- every session open reads it by session_id (routes/sessions.js history
-- loads), i.e. a sequential scan over the whole message table each time.
-- The leading column serves those lookups; `model` rides along so a
-- future per-model cost aggregate can read it index-only.
CREATE INDEX IF NOT EXISTS idx_csm_session_model
  ON chat_session_messages(session_id, model);

-- Migrations (idempotent)
ALTER TABLE chat_session_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS cc_session_id VARCHAR(64);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_image_ref TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_build_ref VARCHAR(253);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_runtime_kind VARCHAR(32);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_runtime_name VARCHAR(253);
-- The commit the preview was actually built from (the clone's HEAD at build
-- time). A clean platform sync of main carries the checks verdict forward
-- WITHOUT a rebuild, so the preview can sit a commit behind the head the
-- row now describes; "Re-run checks" compares this to the head and rebuilds
-- instead of testing the new head's checks against the old build. NULL for
-- previews built before this column existed, which keeps the old behaviour.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS staging_commit_sha VARCHAR(64);
-- LLM-generated PR title shown alongside the PR number across the UI
-- (dev chat, vote panel, status page). Nullable so old rows predate the
-- auto-title feature and just fall back to showing "by <user>".
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS pr_title VARCHAR(256);
-- #8: how many commits the session branch is behind origin/main, as of
-- the most recent worker turn. Updated by run-cc.sh on every turn
-- (MODE=build and MODE=sync) via the BEHIND= field of the
-- __USERNODE_RESULT__ line. Drives the "Sync with main" banner in the
-- dev-chat session view and the merge-time block in votes.tryMerge.
-- Defaults to 0 for fresh rows; existing rows backfill on their next
-- turn (no separate migration backfill — pre-#8 sessions just show no
-- banner until they next run).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS behind_main INTEGER NOT NULL DEFAULT 0;
-- Opt-in session visibility: NULL = private to the owner (every
-- pre-existing row), non-NULL = "visible to everyone" — the session
-- renders at the bottom of other users' In progress area on the Dev
-- board, with its discussion thread (chat_messages thread_type
-- 'session') open to comments. Doubles as the sort key there
-- (oldest-shared first so newly shared rows append at the bottom).
-- Set/cleared by POST /api/sessions/:id/share|unshare (owner-scoped);
-- naming mirrors chat_session_specs.shared_to_group_at ("private until
-- explicitly shared").
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
-- Opt-in TRANSCRIPT visibility — a second, strictly NARROWER opt-in that
-- sits on top of shared_at: NULL = the conversation with the AI stays
-- private to the owner (every pre-existing row), non-NULL = anyone with
-- view access to the app may READ the dev-chat transcript (and fork it
-- into their own session via POST /api/sessions/:id/fork).
--
-- Readability requires BOTH stamps to be non-NULL, deliberately
-- redundant: /share-transcript sets shared_at too (publishing the chat
-- implies board visibility) and /unshare clears BOTH, so there is no
-- state where a hidden session is still readable. Reads are served by
-- GET /api/sessions/:id/transcript, which sanitises every row through a
-- deny-by-default allowlist (services/transcript-share.js) — costs,
-- token counts, raw agent stderr (metadata.ccLog), owner-only action
-- cards and attachment BYTES never leave the owner's session.
--
-- Posting into someone else's chat stays structurally impossible: POST
-- /api/sessions/:id/chat is owner-scoped (cs.user_id = caller), so
-- "read-only" is enforced by authorization, not by missing UI.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS transcript_shared_at TIMESTAMPTZ;
-- #361: persisted merge-conflict snapshot so proposal cards can render a
-- rich merge-status badge (clean | behind | conflict | resolving |
-- failed) without a live GitHub call per render. Derived/written by
-- services/sync-main.js (persistConflictState), the sync the proposal
-- machine runs; `behind` is derived when behind_main>0
-- and the branch still merges cleanly. conflict_files holds the file
-- paths that contained conflict markers on the last detection, and
-- conflict_checked_at is when the snapshot was last computed.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_conflict_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_files JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_checked_at TIMESTAMPTZ;
-- #381: console-error "may break the app" check. After each staging build
-- the capture pipeline's headless browser records console errors / uncaught
-- exceptions / failed loads on the staging "after" target(s). Written by
-- services/visuals.js (captureForSession → storeConsoleCheck), latest run
-- only. console_check_state is 'clean' | 'errors' | 'unknown' (NULL until
-- the first check); console_errors is the captured {kind,message,source}
-- list; console_checked_at is when it last ran. Advisory only — never gates
-- voting or merge.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_errors JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_checked_at TIMESTAMPTZ;
-- #47: "CI for proposals". The console-error check above is now the
-- built-in baseline of a general "tests run against staging" framework: a
-- proposal carries automated headless-browser tests (declared in the app's
-- dapp.json `tests` array, accumulating across proposals like CI in a
-- GitHub repo), each navigating one staging route and asserting the page
-- loads, throws no console errors, and (optionally) shows an expected
-- selector/text. After every staging build services/visuals.js runs them
-- (captureForSession → storeChecks) and records the outcome here, latest
-- run only.
--   check_state       : 'passing' | 'failing' | 'pending' | 'error' |
--                       'skipped' | 'unknown' (NULL until the first run).
--                       'pending' is set the moment a (re)build starts so a
--                       stale pass can't slip through; 'error'/'unknown' mean
--                       the staging build or capture run itself broke.
--   test_results      : array of { name, path, status:'pass'|'fail',
--                       consoleErrors:[{kind,message,source}], failureReason }
--   checks_commit_sha : the commit the results describe (staleness signal).
--   checks_checked_at : when the suite last ran.
-- Unlike the advisory console columns above, check_state GATES merge:
-- the merge gate (routes/votes.js evaluateMergeGate) blocks a non-'passing' proposal (admin
-- force-merge still bypasses). The console_* columns are kept written in
-- parallel for one release so a rolling deploy's old readers still work.
-- #447: 'pending' is only ever advanced out by the same captureForSession
-- run that set it, so a restart mid-capture (or a staging rebuild that
-- predated the capture wiring) could leave a submitted CLI handoff or promoted
-- PR 'pending'/NULL and permanently merge-blocked. A 'pending' row whose
-- checks_checked_at is older than CHECKS_STALE_MS (default 10m) is now treated
-- as STUCK and
-- re-run: by server.js reconcileStuckChecks (boot + session-sweeper Pass 4),
-- by a vote that reaches threshold (the merge gate's stale-pending kick), by any
-- staging rebuild (staging-recovery.rebuildSessionStaging now re-runs checks),
-- and by the manual POST /api/sessions/:id/recheck ("Re-run checks" button).
-- #461: 'skipped' is a TERMINAL, GATE-PASSING verdict recorded when the
-- checks genuinely cannot / need not run — the branch carries no commits
-- beyond main, or GitHub isn't configured so no checks infrastructure
-- exists. Written by the preview machine's storeChecksSkipped (via
-- staging-recovery.recordChecksSkipped) with the human-readable reason in
-- check_error_detail (same column the badge tooltip already surfaces); the
-- merge gate treats it exactly like 'passing', and the next pushed commit
-- returns the row to 'pending' via setChecksPending as usual. Before #461
-- these paths returned silently, leaving check_state NULL — merge-blocked
-- as "still running its tests" forever while the stuck-checks sweeper
-- re-skipped the same row every pass.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS test_results JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_commit_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_checked_at TIMESTAMPTZ;
-- Capture-outcome snapshot (screenshot-reliability spec). Before these,
-- "this proposal has no screenshots" was unattributable: an intentional
-- console-only run (no frontend files in the commit range) and a genuinely
-- failed capture looked identical, and per-artifact failure reasons (a
-- dropped over-cap webm, a screencast/ffmpeg error) lived only in
-- short-lived container logs. Written by services/visuals.js
-- (captureForSession → storeCaptureOutcome), latest run only.
--   capture_state  : 'captured'     — media run, everything usable stored
--                    'partial'      — media run stored, but some artifact
--                                     failed or was dropped over-cap
--                    'console_only' — non-UI-affecting commit range; media
--                                     intentionally skipped (NOT a failure)
--                    'failed'       — media run produced no usable "after",
--                                     or the capture run itself broke
--                    (NULL until the first outcome-aware run)
--   capture_detail : jsonb diagnostics — { media, pathDefaulted (capture
--                    used '/'), routeSource ('submitted' | 'scenario' |
--                    'default'), scenarios:[{id,path,
--                    fingerprint,...}], prodRunning, paths,
--                    failures:[{kind,media,index,
--                    reason}], droppedOverCap:[{kind,media,index,bytes}],
--                    beforeFellBack:[capture indexes], reason? }
--   captured_at    : when the outcome was recorded.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_state VARCHAR(16);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_detail JSONB;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
-- Deadlock-diagnosis columns. Before these, a staging build that crashed on
-- boot threw before any verdict was written, leaving check_state NULL — the
-- merge gate fail-closes on NULL with no signal, and the stuck-checks sweeper
-- retried the identical failing build every ~2 min forever (an "unclear
-- deadlock": votes pass, nothing merges, nobody is told why). Now a build/boot
-- failure is recorded as a terminal 'error' verdict carrying:
--   check_error_detail       : a concise, human-readable reason for the LAST
--                              failure (e.g. the Postgres error / crash line
--                              pulled from the container's boot logs). Surfaced
--                              in the merge-gate message, the proposal thread,
--                              and the proposal's checks badge tooltip.
--   consecutive_check_failures : count of back-to-back failed check runs for
--                              the current commit. Reset to 0 on any passing/
--                              failing verdict and when a NEW commit starts a
--                              check run (see preview/check-store.ts setChecksPending). Drives
--                              the sweeper's exponential backoff + the
--                              crash-loop short-circuit (stop auto-retrying a
--                              deterministically-failing build after N tries).
--   first_check_failure_at / last_check_failure_at : streak bounds, for "stuck
--                              for X hours" escalation + diagnostics.
--   check_next_retry_at      : earliest time the sweeper may re-attempt this
--                              errored check. Set to NOW()+backoff on each
--                              failure; the sweeper only re-picks an 'error'
--                              row once this has elapsed, replacing the old
--                              fixed ~2 min retry with 2m → 4m → 8m → … → 30m.
--   check_error_notified_at  : stamped when the proposal owner is notified of
--                              the failure, so they're nudged once per streak
--                              (cleared when a new commit resets the streak).
--   check_error_platform     : the stored 'error' is the platform's fault and
--                              nothing else: the unit suite's Job was refused
--                              or lost before any of the proposal's code ran
--                              (unit-suite-row.isPlatformNotRun). Written with
--                              every 'error'. Such a row is not held to
--                              CHECK_MAX_AUTO_RETRIES: the error lane keeps
--                              retrying it for a day from the streak's first
--                              failure, and a platform boot makes it due at
--                              once (services/staging-recovery.js).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_detail TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS consecutive_check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS first_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS last_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_next_retry_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_notified_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_platform BOOLEAN NOT NULL DEFAULT false;
-- Which STAGE a 'pending' check run is in, so the proposal card can say
-- "Preparing the staging preview…" vs "Running the automated tests…"
-- instead of one opaque "Checks are still running…" for the whole run.
-- A run has two very differently-sized halves and both used to look
-- identical, which made a mid-flight build indistinguishable from a wedged
-- one. Values:
--   'building' — the branch is being built and the preview's database
--                clone is being made (set by the callers that stamp
--                'pending' BEFORE buildAndDeployStaging).
--   'queued'   — the preview is healthy and the run is waiting for a
--                checks slot (services/checks-queue.js) before it creates
--                any Job; checks_progress.queue.ahead is its place in line.
--   'testing'  — the preview is healthy and the headless suite is running
--                against it (set by visuals.captureForSession's own
--                setChecksPending at capture start).
-- NULL on legacy rows and after any terminal verdict; the card falls back
-- to its previous wording for NULL, so nothing regresses on old proposals.
-- Advisory/display only — the merge gate reads check_state, never this.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_phase VARCHAR(24);
-- WHY this check run started, alongside check_phase's "which half is it in".
-- The merge-gate trace recorded trigger='capture' for every run — literally
-- the name of the function that opened it — so a measurement of "1.81 checks
-- runs per proposal, 91 of 204 are re-runs" could count the re-runs but could
-- not say which were a human pressing Re-run, which were a new commit, and
-- which were the recovery sweeper re-driving a run that had gone quiet. Those
-- want completely different fixes. Values are visuals.CHECK_TRIGGERS
-- ('proposal-open', 'commit-push', 'sync-main', 'pr-import',
-- 'manual-recheck', 'promote-kick', 'boot-reconcile', 'stuck-sweep',
-- 'fleet-maintenance'); anything else is stored as NULL.
-- NULL on legacy rows and whenever the writer did not name one — the card
-- simply shows no trigger caption then. Advisory/display only, exactly like
-- check_phase: the merge gate reads check_state and nothing else.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_trigger VARCHAR(32);
-- The head a person asked to have checked again ("Run checks again"), while
-- a unit suite that really runs on it is still owed (services/unit-suite-
-- reuse.js). Set with the 'manual-recheck' pending stamp; cleared when a
-- verdict whose unit suite ran on that head is stored. While it names the
-- head, no run copies an earlier pass and no verdict carrying a copied one
-- is stored. Survives restarts on purpose.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS unit_suite_fresh_sha TEXT;
-- Live progress of the run in flight: `{ ran, passed, failed, expected,
-- updatedAt, unit, build }`, written as the capture container's per-check
-- frames stream in. `unit` is the repo unit suite's own `{ phase, ran,
-- passed, failed, skipped, expected, done }`, read off its TAP output the
-- same way; `build` is the staging build's steps and their times. The
-- verdict itself stays in test_results; this is what "checks running" has
-- to say between the start and the end, which used to be nothing. With
-- the verdict (#2170) the snapshot is reduced to what the run cost —
-- `{ build, checksMs }`, the finished build and the checks' wall clock —
-- so the card can still say how long both took; the next run's start
-- clears it. NULL before a run has reported.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_progress JSONB;
-- The unit suite's size from its last completed run (`# tests`), so the
-- next run's live bar has a denominator before the suite finishes.
ALTER TABLE apps                   ADD COLUMN IF NOT EXISTS unit_suite_last_tests INTEGER;
-- Unit-suite passes a later checks run of the same commit may copy instead
-- of running the suite again (services/unit-suite-reuse.js). One row per
-- pass the suite's own process saw end, keyed on everything the verdict
-- depends on beside the clock: the repository and full commit, the worker
-- image by digest, and a hash of the Job the platform wraps around the
-- tests (unit-suite.jobDefinition). Rows older than twice the reuse age
-- limit are deleted with the app's next pass. Platform bookkeeping with no
-- use in a preview, so a preview's copy starts empty.
CREATE TABLE IF NOT EXISTS unit_suite_passes (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  commit_sha  VARCHAR(40) NOT NULL,
  image       TEXT NOT NULL,
  job_definition VARCHAR(64) NOT NULL,
  session_id  INTEGER,
  run_id      TEXT,
  summary     JSONB,
  passed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the run that passed stored its verdict and recorded the pass in
  -- app_check_history. Only an observed pass is reused, so the gate a copy
  -- earns always has the app's history row behind it.
  observed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_unit_suite_passes_commit
  ON unit_suite_passes (app_id, commit_sha, passed_at DESC);
-- The commit's tree, when GitHub said it (NULL otherwise): main-watch copies
-- a pass of the same tree for a merge that lands it under a new commit
-- (services/unit-suite-reuse.js findTreePass).
ALTER TABLE unit_suite_passes ADD COLUMN IF NOT EXISTS tree_sha VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_unit_suite_passes_tree
  ON unit_suite_passes (app_id, tree_sha, passed_at DESC) WHERE tree_sha IS NOT NULL;
COMMENT ON TABLE unit_suite_passes IS 'staging:private';
-- #11: vote-to-undo a merged PR. When the undo majority is reached we
-- open a `git revert <merge_commit_sha>` PR and insert a new
-- chat_sessions row pointing back here via revert_of_session_id.
-- The new row goes through the regular promoted → merging → merged
-- flow (a second checkpoint instead of single-voter rollback), so
-- this is just bookkeeping for the original.
--   merge_commit_sha is captured from github.mergePR's response in
--   votes.tryMerge so the revert helper has a SHA to revert.
--   revert_of_session_id, when NOT NULL, marks this row as itself a
--   revert PR — the UI hides chat input + the undo button on
--   reverts so we can't vote-to-undo-an-undo from the merged list.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_commit_sha    VARCHAR(40);
-- A recovery sweep may release a failed merge claim only after its GitHub
-- request has had time to finish. The timestamp is set with the claim.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_attempt_at   TIMESTAMPTZ;
-- Retired with the old merge paths: what a merge still owed once recorded
-- (the merge-followups machine keeps that as durable work).
DROP INDEX IF EXISTS chat_sessions_merge_followups_due_idx;
ALTER TABLE chat_sessions          DROP COLUMN IF EXISTS merge_followups_due_at;
ALTER TABLE chat_sessions          DROP COLUMN IF EXISTS merge_followups_done;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS revert_of_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_sessions_revert_of_idx ON chat_sessions(revert_of_session_id);

-- #11/#16: DEPRECATED. Originally held undo votes on merged PRs (a
-- separate majority gate before a revert PR could be opened). As of #16
-- undo is a single direct action — clicking Undo opens a revert PR
-- immediately and the revert's own merge vote is the only checkpoint —
-- so nothing reads or writes this table anymore. Kept (not dropped) to
-- avoid a destructive migration on existing deployments.
CREATE TABLE IF NOT EXISTS pr_undo_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS pr_undo_votes_session_idx ON pr_undo_votes(session_id);

-- Spec-stage: per-session markdown spec doc + version history.
-- spec_md is the working buffer (written by the Mayor's scout dispatch
-- — user hand-edits via PUT /spec were dropped, and the Mayor's
-- in-process write_spec/edit_spec tools were removed in #111).
-- chat_session_specs holds the immutable numbered versions (v1…vN) that
-- are the single spec surface the dev-chat viewer presents (#69). Rows
-- are inserted automatically by snapshotSessionSpec() on every spec
-- mutation (#27), so spec_md is always byte-identical to the latest
-- version. The manual "Save version" route (POST /api/sessions/:id/specs)
-- was retired in #69 — it only ever re-snapped that same content.
-- Old sessions also have rows from the now-removed /build-spec route —
-- those carry commit_sha and pr_number; auto-snapshotted rows leave both
-- NULL and the UI degrades gracefully (no PR link rendered).
-- shared_to_group_at is set when the user posts a version into the
-- app's group chat.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS spec_md TEXT NOT NULL DEFAULT '';
-- #3699: a spec may be written as a small HTML document (before/after
-- screens, diagrams; src/services/spec-html.js). spec_html is that document
-- and spec_md is then its MARKDOWN COPY, so spec_md stays byte-identical to
-- the latest version's content and every reader of spec text keeps working.
-- NULL for a markdown spec. chat_session_specs.content_html is the same per
-- version. Both tables are staging:private, which covers these columns.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS spec_html TEXT;

-- Session auto-pause: persisted "last interacted with" timestamp. Bumped
-- on every chat turn, on session open/view, and on resume. The DB-driven
-- auto-pause sweeper (server.js) flips long-idle 'active' sessions to
-- 'paused' so they stop counting against the per-user / global session
-- caps; the in-memory worker idle-eviction (which only reclaims the
-- container) is a separate, shorter-timer concern. DEFAULT NOW() is
-- deliberate: it backfills existing rows to "active now" so the first
-- sweep after this migration doesn't mass-pause every open session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Supports the sweeper's "active + idle past threshold" scan.
CREATE INDEX IF NOT EXISTS chat_sessions_activity_idx ON chat_sessions(status, last_activity_at);

-- #155: headless "auto sessions" started from an issue's Auto-solve button.
-- A headless session is NOT connected to any user's dev chat: it runs one
-- unattended Mayor turn (scout / build / question) against the issue, may
-- push a branch, but never opens a PR or builds staging. It is billed to
-- the user who clicked the button (user_id), and any collaborator can later
-- clone its state (messages + spec + branch + CC memory) into their own
-- dev-chat session via POST /api/sessions/:id/clone-headless.
--   is_headless            = marks the row as an auto session; excluded from
--                            per-user session lists, the 3-slot cap, and chat.
--   headless_status        = 'generating' (run in flight) | 'ready' | 'failed'.
--                            NULL on ordinary sessions.
--   headless_issue_number  = the GitHub issue the auto session was started for.
--   headless_outcome       = what the run arrived at: 'spec' | 'code' |
--                            'spec_code' (#170 — scout drafted a spec AND the
--                            decision turn implemented it) | 'question'. Drives
--                            the cloned session's follow-up message. NULL until
--                            the run finishes.
--   cloned_from_session_id = on ORDINARY sessions: the session this dev chat
--                            was seeded from (many clones/forks per source).
--                            Two producers, told apart by the SOURCE row's
--                            is_headless: the headless auto session this was
--                            cloned from (POST /clone-headless), or — since
--                            transcript sharing — another user's HUMAN dev
--                            chat this was forked from (POST /fork, source
--                            is_headless = FALSE). Either way the copied
--                            history rows carry metadata.inheritedFrom, which
--                            is what DevChat._markInheritedMessages keys the
--                            collapsed-agent-block rendering off.
--   created_from_issue_number = #287: on ORDINARY sessions, the GitHub issue
--                            this dev chat was started for via the issue row's
--                            start-work button. Recorded at creation time (not
--                            the async, Mayor-declared `linked_issues`) so the
--                            row can deterministically swap "Create proposal" →
--                            "Create new proposal" for the owning viewer. NULL on
--                            the generic "+ New chat" path and on headless rows.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_headless BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_status VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_issue_number INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_outcome VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cloned_from_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS created_from_issue_number INTEGER;
-- Supports the per-issue "latest auto session" lookup on the issues panel.
CREATE INDEX IF NOT EXISTS chat_sessions_headless_idx
  ON chat_sessions(app_id, headless_issue_number, created_at DESC)
  WHERE is_headless;
-- #287: supports the per-viewer "latest Create-PR session for this issue"
-- lookup on the issues panel (GET /github-issues → myPrSessionId).
CREATE INDEX IF NOT EXISTS chat_sessions_created_from_issue_idx
  ON chat_sessions(app_id, created_from_issue_number, user_id, created_at DESC)
  WHERE created_from_issue_number IS NOT NULL;

-- #687 (PR-import, Slice 1): provenance columns for proposals whose code
-- was authored OUTSIDE the platform — an existing GitHub PR imported into
-- the vote flow rather than opened by the group's AI dev-chat. Append-only:
-- existing rows read as native (source NULL/'native').
--   source               = 'native' (implicit for every existing row; a
--                          NULL value is treated as native), 'imported', or
--                          one of the native workflow provenance markers
--                          documented below (`cli_handoff`, `maintenance`).
--                          Drives the "Imported PR" source badge + GitHub
--                          link and the read-only dev surface for imported
--                          proposals.
--   imported_pr_head_sha = the PR head commit the current checks/votes
--                          describe. A later push moves the PR head; the
--                          Slice 3 sync poller compares against this to
--                          reset the tally, and Slice 4 pins the merge to
--                          exactly this SHA. NULL for native rows.
--   imported_pr_author   = display handle of the external PR author, shown
--                          beside the badge. NULL for native rows.
--   imported_pr_head_repo= 'owner/repo' of the repository the PR's HEAD
--                          branch lives in, as GitHub reported it at import
--                          time (#1196). NOT the same question as `source`:
--                          the connector's mirror rung copies an agent's
--                          verified fork branch into the APP repository and
--                          opens a same-repo pull request, which is then
--                          imported here — so an 'imported' row's head is
--                          sometimes a branch only the platform bot can
--                          write. Recorded because it decides which update
--                          path a revision takes (services/proposal-update.js
--                          `branchHomeOf`) and what get_proposal tells an
--                          agent to push to. NULL for native rows and for
--                          rows imported before this column existed; that
--                          fallback is documented at `branchHomeOf`.
-- NOTE: a partial UNIQUE index on (app_id, pr_number) WHERE source='imported'
-- is intentionally DEFERRED (see spec Considerations) — Slice 1 relies on
-- the read-only boot audit in db/migrate.js instead of a hard constraint,
-- to keep this migration strictly append-only.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_head_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_author   VARCHAR(255);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_head_repo TEXT;
-- Exact revision approved for a native proposal. Imported proposals keep
-- imported_pr_head_sha as their existing source of truth; native votes,
-- checks, and merges are bound to this live GitHub PR head instead.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reviewed_head_sha     VARCHAR(40);
-- Native CLI handoff sessions. A local Codex/Claude agent can author the
-- spec and code in the user's checkout, then attach that durable context and
-- an exact-tree bot-owned commit to an ordinary platform-owned dev session. The row
-- remains a native session (not an imported PR), so the same chat can be
-- opened and continued from the web Dev page and uses the normal
-- staging/checks/promotion pipeline.
--
-- handoff_request_id is a caller-generated idempotency key scoped to the
-- owner. base is the immutable audit anchor, uploaded is the latest bot-owned
-- commit reconstructed from a local tree, and head is the latest uploaded
-- revision explicitly submitted to staging/checks. A web Dev turn may advance
-- the shared branch/checks_commit_sha without overwriting those local audit
-- values. local_commit is the corresponding commit identity in the user's
-- checkout; it may differ from uploaded while their trees are identical.
-- Later local uploads must still continue from the current branch tree.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_request_id VARCHAR(64);
-- Immutable digest of proposal_start's normalized app/base/title/spec/history/
-- issue payload. Live session fields legitimately change after local or web
-- continuation, so they cannot serve as the idempotency comparison.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_request_fingerprint VARCHAR(64);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_base_sha   VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_head_sha   VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_uploaded_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_local_commit_sha VARCHAR(40);
-- Snapshot of checks_commit_sha immediately before handoff_uploaded_sha was
-- written. Equality means the upload is still awaiting submission; a later
-- web turn naturally changes checks_commit_sha and supersedes that upload
-- without needing to know about CLI-specific state.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_upload_checked_sha VARCHAR(40);
-- Explicit replacement lineage for local proposal handoffs. A new request ID
-- may replace a same-owner, same-app pre-vote handoff only when the caller
-- names it. proposal_start archives the predecessor and inserts the successor
-- in one transaction; the nullable self-reference preserves that decision
-- without imposing uniqueness on an issue (other authors and promoted
-- alternatives remain valid proposals).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS handoff_supersedes_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_sessions_handoff_supersedes_idx
  ON chat_sessions(handoff_supersedes_session_id)
  WHERE handoff_supersedes_session_id IS NOT NULL;
-- Deliberately scoped independently of source: a delayed proposal_start retry
-- must always resolve to the same cross-surface session.
CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_handoff_request_idx
  ON chat_sessions(user_id, handoff_request_id)
  WHERE handoff_request_id IS NOT NULL;

-- ============================================================-- #907: local coding agents.
--
-- A user can attach a coding agent running on their own machine to one of
-- their dev sessions and have the Mayor dispatch that session's coding turns
-- to it instead of to a platform worker container. Everything after the agent
-- finishes — commit upload, staging, checks, visuals, PR metadata — is the
-- SAME pipeline the platform worker and the MCP proposal handoff already use,
-- so a local turn produces an ordinary proposal that anyone can review.
--
-- The platform never receives, stores, or proxies the user's own model
-- credentials: the local runtime authenticates to Anthropic itself, out of
-- band, exactly as it does when the user runs `claude` by hand.
-- ===================================================================

-- One machine's claim on one session. The unique partial index is the whole
-- exclusivity story: at most one unreleased lease per session, so a second
-- laptop attaching to the same chat is refused rather than racing.
--
-- `expires_at` is a hard TTL refreshed by heartbeat. A laptop that closes its
-- lid, loses Wi-Fi, or is killed simply stops heartbeating; the lease lapses
-- and the session falls back to the platform worker on its next turn without
-- anyone having to click anything.
CREATE TABLE IF NOT EXISTS session_agent_leases (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which credential this machine attached with. ON DELETE SET NULL rather
  -- than CASCADE: revocation is a soft `revoked_at` (and detaches the lease
  -- explicitly, in the same transaction), while the row itself is only ever
  -- hard-deleted by the expiry prune long afterwards — which must not
  -- retroactively erase the record of where a session's turns ran.
  access_token_id BIGINT REFERENCES cli_access_tokens(id) ON DELETE SET NULL,
  -- User-chosen, display-only ("Evan's laptop"). Never a hostname the
  -- platform discovered by itself.
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
  -- Which local runtime is driving. Only 'claude-code' exists in phase 1;
  -- the column is here so a second adapter does not need a migration.
  runtime TEXT NOT NULL DEFAULT 'claude-code'
    CHECK (runtime IN ('claude-code')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  -- 'detached' = the CLI left cleanly; 'revoked' = the owner clicked
  -- "Hand back to Usernode" in the browser or Settings; 'expired' = the
  -- heartbeat lapsed and a sweeper reaped it.
  release_reason TEXT
    CHECK (release_reason IN ('detached', 'revoked', 'expired')),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CHECK (last_seen_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS session_agent_leases_active_uidx
  ON session_agent_leases (session_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS session_agent_leases_user_idx
  ON session_agent_leases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_agent_leases_expiry_idx
  ON session_agent_leases (expires_at) WHERE released_at IS NULL;

-- One dispatched coding turn, offered to the lease that owns the session.
--
-- The lifecycle is deliberately explicit rather than a boolean pair: the
-- platform must be able to tell "the laptop never picked this up" (queued →
-- abandoned) apart from "the laptop picked it up and the run failed"
-- (accepted → running → failed), because only the first is safe to silently
-- re-route to a platform worker.
CREATE TABLE IF NOT EXISTS local_agent_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  lease_id BIGINT NOT NULL REFERENCES session_agent_leases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'offered', 'accepted', 'declined',
      'running', 'completed', 'failed', 'stopped', 'abandoned'
    )),
  -- Which KIND of turn this is. 'build' writes code and produces a commit;
  -- 'scout' is read-only and produces the session's spec document instead.
  -- The distinction is load-bearing rather than cosmetic: it drives the
  -- read-only invariant below, the runtime's permission mode on the user's
  -- machine, and whether the platform runs the staging/checks tail at all.
  mode VARCHAR(16) NOT NULL DEFAULT 'build'
    CHECK (mode IN ('build', 'scout')),
  -- The Mayor's dispatch prompt plus the platform context blocks. Bounded so
  -- a runaway spec cannot turn this table into a document store.
  prompt TEXT NOT NULL CHECK (char_length(prompt) <= 262144),
  -- The base the local checkout must be sitting on for this turn to be safe
  -- to accept. The CLI refuses a turn whose base it cannot reproduce.
  base_sha VARCHAR(40) CHECK (base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'),
  branch_name TEXT,
  -- Free-text progress the local runtime streams back, rendered in dev chat
  -- exactly like worker progress lines. Capped by the route, not the column.
  progress JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(progress) = 'array'),
  -- What the run produced: the local commit the CLI then uploads through the
  -- existing exact-tree commit-upload endpoint, and the agent's own summary.
  head_sha VARCHAR(40) CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{40}$'),
  summary TEXT CHECK (summary IS NULL OR char_length(summary) <= 32768),
  -- A scout turn's actual product: the markdown spec document the local agent
  -- drafted, which the platform writes to chat_sessions.spec_md exactly as it
  -- does for a worker-container scout. Separate from `summary` because it is
  -- the deliverable, not a description of one, and it is bounded like `prompt`
  -- rather than like a summary.
  spec_md TEXT CHECK (spec_md IS NULL OR char_length(spec_md) <= 262144),
  error_detail TEXT CHECK (error_detail IS NULL OR char_length(error_detail) <= 4096),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  offered_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (offered_at IS NULL OR offered_at >= created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (finished_at IS NULL OR finished_at >= created_at),
  -- A terminal row must say when it ended; a live one must not claim to have.
  CHECK (
    (status IN ('declined', 'completed', 'failed', 'stopped', 'abandoned')
     AND finished_at IS NOT NULL)
    OR (status IN ('queued', 'offered', 'accepted', 'running')
     AND finished_at IS NULL)
  ),
  -- THE read-only invariant, in the schema rather than only in the route: a
  -- scout turn can never carry a commit, and a build turn can never carry a
  -- spec. The protocol validates both too, but a scout turn that smuggled a
  -- head SHA would reach the staging/checks tail and put unreviewed code on
  -- the managed branch — so the database refuses it as well.
  CHECK (mode = 'build' OR head_sha IS NULL),
  CHECK (mode = 'scout' OR spec_md IS NULL)
);

-- At most one live turn per session. Same reasoning as the lease index: the
-- Mayor dispatching twice (a retry, a double-submit) must collide loudly
-- here rather than have two laptops commit onto the same branch.
CREATE UNIQUE INDEX IF NOT EXISTS local_agent_turns_live_uidx
  ON local_agent_turns (session_id)
  WHERE status IN ('queued', 'offered', 'accepted', 'running');
CREATE INDEX IF NOT EXISTS local_agent_turns_lease_idx
  ON local_agent_turns (lease_id, created_at DESC);
CREATE INDEX IF NOT EXISTS local_agent_turns_session_idx
  ON local_agent_turns (session_id, created_at DESC);

-- Scout support, added after the table already existed on some databases.
-- CREATE TABLE IF NOT EXISTS skips the whole definition above once the table
-- is there, so the two columns and their invariants need explicit migrations.
ALTER TABLE local_agent_turns
  ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'build';
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS spec_md TEXT;
DO $$
BEGIN
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_mode_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_mode_check
    CHECK (mode IN ('build', 'scout'));
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_spec_len_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_spec_len_check
    CHECK (spec_md IS NULL OR char_length(spec_md) <= 262144);
  -- The read-only invariant again, for databases that predate it. Named so a
  -- re-run replaces rather than duplicates it (an unnamed CHECK added by the
  -- CREATE TABLE above gets a generated name and is left alone, which is
  -- fine — the two express the same rule).
  ALTER TABLE local_agent_turns DROP CONSTRAINT IF EXISTS local_agent_turns_readonly_check;
  ALTER TABLE local_agent_turns ADD CONSTRAINT local_agent_turns_readonly_check
    CHECK ((mode = 'build' OR head_sha IS NULL) AND (mode = 'scout' OR spec_md IS NULL));
END $$;

-- Who on the platform side is waiting for a local turn, and who ran its
-- post-turn tail (commit → PR → staging → checks → completion card →
-- wrap-up). The waiter lives in the process that dispatched the turn, so a
-- restart kills it while the laptop keeps working; without these, nothing
-- ever finished such a turn. The waiter renews `waiter_seen_at` while it
-- waits, under its `waiter_id`. A waiter that stops renewing (its process
-- died) is taken over by the leader's recovery pass
-- (services/local-agent-recovery.js), which takes the waiter id over. Whoever holds
-- the id when the turn ends claims `tail_claimed_at`, once, and runs the
-- tail; `tail_finished_at` says the recovered tail got to its end. Rows from
-- before this existed have no waiter id and are never taken over.
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS waiter_id UUID;
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS waiter_seen_at TIMESTAMPTZ;
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS tail_claimed_at TIMESTAMPTZ;
ALTER TABLE local_agent_turns ADD COLUMN IF NOT EXISTS tail_finished_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS local_agent_turns_waiting_idx
  ON local_agent_turns (waiter_seen_at)
  WHERE waiter_id IS NOT NULL AND tail_claimed_at IS NULL;

-- Both tables describe a specific person's machine and the prompts sent to
-- it, so a staging clone must never carry them. See tools/clone-db.
COMMENT ON TABLE session_agent_leases IS 'staging:private';
COMMENT ON TABLE local_agent_turns IS 'staging:private';

-- Where this session's LAST coding turn actually ran ('platform' | 'local'),
-- and the label of the machine that ran it. Both are display state: the
-- authoritative "can this session run locally right now" answer is always a
-- live row in session_agent_leases. They exist so a reloaded dev chat can
-- paint the "Ran on Evan's laptop" chip without waiting for a lease lookup,
-- and so the chip survives the laptop detaching afterwards.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_turn_runner  VARCHAR(16);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS local_agent_label TEXT;

-- Each local transcript item carries a stable handoffEventId in metadata.
-- This partial expression index makes append/retry idempotent without
-- constraining ordinary web-chat rows, whose metadata has no such key.
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_messages_handoff_event_idx
  ON chat_session_messages(session_id, (metadata->>'handoffEventId'))
  WHERE metadata ? 'handoffEventId';

-- #3177: the optional id a client sends with a dev-chat message
-- (POST /api/sessions/:id/chat `client_message_id`), so a retry after a
-- dropped stream finds the message it already sent instead of starting a
-- second turn. Same shape and rule as conversation_messages.idempotency_key:
-- one per session, and rows sent without one are never constrained.
ALTER TABLE chat_session_messages ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_messages_client_message_idx
  ON chat_session_messages (session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
-- source = 'maintenance' marks proposals opened by a fleet maintenance
-- campaign (services/fleet-maintenance.js): platform-authored PRs fanned
-- out to child apps after a maintenance_campaign governance vote passes.
-- Same column as the 'imported' discriminator above; NULL stays native.
-- The campaign tables themselves live below the issues table (they FK
-- to it).

-- Restart-proof turns + resumable headless runs.
--   active_turn   = durable record of an in-flight detached CC turn:
--                   { turnId, phase, mode, journal, model, startedAt }. Set by
--                   worker.execInWorker before the detached `docker exec`
--                   dispatch and cleared after post-turn processing. On boot,
--                   server.js's adoption path uses it to replay the turn's
--                   journal file (in the CC volume) instead of killing the
--                   still-running in-container claude. NULL = no turn in
--                   flight.
--
--                   Two further keys cover the POST-AGENT TAIL — the
--                   minutes-long platform-side stretch after the agent
--                   exits (push heal → PR → staging build → cards →
--                   Mayor wrap-up). A `holdTurnRecord` caller keeps the
--                   record alive across it instead of clearing it at exec
--                   end, so a restart mid-tail is resumable rather than
--                   silently dropped (the incident: a turn's chat froze on
--                   "Building staging preview..." forever because a
--                   self-app deploy replaced the process mid-build):
--                     phase — 'tail_pending' once the exec is over and the tail
--                             owns the record. New rows otherwise use
--                             'dispatch_pending' / 'executing' and finish via
--                             'cleanup_pending'; an absent phase is interpreted
--                             as executing only for rolling-deploy compatibility.
--                     tail  — milestone map of what the tail ALREADY did,
--                             so a resumed tail repeats none of the steps
--                             that aren't idempotent:
--                             { sha, pushOk, prNumber,
--                               prOpenedEventRecorded, stagingUrl,
--                               votesResetFor, completionRowPosted,
--                               stagingPublished, stagingFailed,
--                               wrapUpPosted }.
--                             finalizeRecoveredTurn takes it as
--                             `alreadyDone`. Written with jsonb_set
--                             merges guarded on `active_turn IS NOT NULL`,
--                             so a late stamp can never resurrect a
--                             released record.
--   headless_step = where the headless auto-session loop last checkpointed:
--                   'planning' (Mayor phase-1) | 'cc_running' (CC turn
--                   dispatched) | 'wrapping' (Mayor phase-2). Lets
--                   resumeHeadlessRuns continue a 'generating' row after a
--                   restart instead of blanket-failing it. NULL on ordinary
--                   sessions and on headless rows finished before this column
--                   existed.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_turn   JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_step VARCHAR(20);
-- Stable identity for the current post-agent headless Mayor phase. A single
-- auto-session may scout and then build (two coding turns), so wrap-up
-- receipts cannot safely borrow whichever active_turn happens to exist.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_turn_id UUID;

-- #161: "owner left while a turn was in flight; notify on completion".
-- Armed/disarmed by the client via POST /api/sessions/:id/notify-on-done
-- the moment the owner stops watching a running turn; checked + cleared
-- at every turn-completion point (the chat handler's done hook and
-- server.js resumeDetachedTurn). Persisted rather than in-memory so
-- restart-recovered turns honor it.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS notify_on_done BOOLEAN NOT NULL DEFAULT FALSE;

-- GitHub issue linkage (#75): the open issues this session's work addresses,
-- declared by the Mayor via dispatch_claude_code / dispatch_scout's
-- `addresses_issues` arg. Accumulates (union) across turns, and shrinks via
-- the tools' `removes_issues` counterpart (#733) when scope is cut
-- mid-session — removal wins over an addition of the same number in the
-- same call. pr-metadata.js appends a `Closes #N` line per number to the PR
-- body so merging the PR auto-closes the issue. `pr_linked_issues_applied`
-- snapshots what was last written to the live PR body so the existing-PR
-- update path can detect a changed linkage even when the title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues             INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_linked_issues_applied  INTEGER[] NOT NULL DEFAULT '{}';
-- One-shot marker for the migrate-time backfill that recovers linked_issues
-- from historical PR bodies (closing keywords) predating the #75 plumbing.
-- Set true once a session's PR has been fetched + parsed so PRs without
-- closing keywords aren't re-fetched from GitHub on every boot.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues_backfilled  BOOLEAN NOT NULL DEFAULT false;

-- #2500 / #2537. TRUE once the originating issue of a session started from
-- an issue card has been seeded into `linked_issues` — at creation for
-- every session made since, and at promote time for the rows that predate
-- it. Before this, an interactive session recorded its issue only in
-- `created_from_issue_number`: the issue board linked back to the session
-- (issue-proposal-ref.js unions both columns) while the proposal itself
-- read "No issues linked yet" and its pull request body carried no
-- `Closes #N`, because both of those read `linked_issues` alone.
-- The flag is what keeps the promote-time backfill from undoing an author:
-- an empty `linked_issues` on a seeded row is a deliberate removal (the
-- Mayor's `removes_issues`, or the linked-issues editor), not a gap to
-- fill.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS issue_link_seeded         BOOLEAN NOT NULL DEFAULT false;

-- Bot-generated testing guidance for PR previews (#127). The coding agent
-- may end a build turn with a "==== TESTING ====" block (parsed by
-- src/services/testing-notes.js):
--   testing_md         : latest "how to test" markdown (NULL = none).
--   testing_path       : validated relative deep-link path into the app that
--                        lands the tester on the changed feature.
--   pr_testing_applied : snapshot of the rendered "How to test" section last
--                        written into the live PR body (the
--                        pr_linked_issues_applied analog) so the existing-PR
--                        update path detects changed guidance even when the
--                        title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_md         TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_path       VARCHAR(512);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_testing_applied TEXT;
--   testing_paths      : ordered list of validated deep-link routes the
--                        before/after capture pipeline shoots a pair at
--                        (#270). Since #768 elements are objects —
--                        { path, viewport: 'desktop'|'mobile' } (`@mobile`
--                        path annotation → phone-sized capture frame);
--                        older rows hold plain path strings and readers
--                        normalize via testing-notes.normalizeStoredPath.
--                        NULL/absent falls back to [testing_path || '/'],
--                        so legacy single-path rows are unchanged.
--                        testing_path stays the PRIMARY path (= the first
--                        of this list) for the "Test this change" button.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_paths      JSONB;

-- Stale-promoted-PR policy + reversible archive.
--   promoted_at       : when the session was proposed to the group. With
--                       the latest pr_votes timestamp this gives the
--                       "interest" recency the stale sweeper measures.
--   stale_notified_at : set when the author was warned the PR is going
--                       stale; cleared when a new vote revives it. The
--                       grace-then-archive step keys off this.
--   archived_at       : when the session was archived. Archive is now
--                       REVERSIBLE within a retention window — the CC
--                       volume + branch are kept so /unarchive restores
--                       it; a hard GC purges the volume only after
--                       archived_at passes ARCHIVED_RETENTION_MS.
--   cc_purged         : TRUE once the hard GC has destroyed the CC volume
--                       (memory gone). /unarchive still works but starts
--                       a fresh Claude session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS promoted_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS stale_notified_at  TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cc_purged          BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS chat_sessions_archived_idx ON chat_sessions(status, archived_at);

-- Exact merge timestamp. Historically chat_sessions only recorded the
-- terminal `status = 'merged'` with no time, so "merges over time" could
-- not be charted (see the note in routes/kudos.js leaderboard query).
-- Set by the merge-followups machine at the moment the PR lands (both
-- vote-driven and admin force-merge paths). NULL for rows merged before
-- this column existed; the events backfill approximates those with
-- promoted_at. Covered by the table-level staging:private comment, so it
-- is scrubbed from staging clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS chat_sessions_merged_at_idx ON chat_sessions(merged_at);

-- #800: per-change CODING-AGENT spend, in cents at Anthropic list price.
-- The platform's first per-change cost figure.
--
-- Why it has to exist: chat_session_messages.cost_cents already records
-- every MAYOR turn's cost, but Claude Code in the worker bills through
-- routes/anthropic-proxy.js, which only ever folded its spend into the
-- per-user *daily* llm_usage ledger — so the agent's share (the large
-- majority: measured at ~4.3x the Mayor's on single-session user-days)
-- was never attributable to the change it was building. Total cost of a
-- change is therefore SUM(chat_session_messages.cost_cents) for the
-- session PLUS this column.
--
-- Written by the anthropic-proxy settle path as a best-effort
-- accumulating increment (one narrow single-row UPDATE per agent call;
-- a session's agent calls are serial so there is no contention).
-- Deliberately EXCLUDES platform-driven sync/merge-conflict turns —
-- those bill system_token_usage, run on a fixed model, and are not a
-- consequence of the user's model choice.
--
-- READING IT LATER — IMPORTANT: every session that predates this column
-- has 0 here despite really having spent money, and the history cannot
-- be backfilled (llm_usage has no session or model dimension). So any
-- aggregate MUST filter `agent_cost_cents > 0`, which is exactly the set
-- of sessions whose agent ran after the ledger existed and self-heals as
-- history accumulates. Without that filter the low end of any cost
-- distribution collapses toward zero.
--
-- This is a list-price cost record, NOT a billing record: it is written
-- identically for BYOK and platform-key turns (llm_usage remains the
-- source of truth for spend against allowances). Covered by the
-- table-level staging:private comment.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_cost_cents NUMERIC(12,4) NOT NULL DEFAULT 0;

-- #2592: the MODEL dimension the ledger above does not have.
--
-- `chat_sessions.agent_cost_cents` answers "what did this change cost in
-- coding-agent time?" but not "on which model?", and that gap was showing
-- up as a WRONG NUMBER on the Model costs console: the observed average
-- and median per change read far too low, because the agent's spend — the
-- large majority of what a change costs — had to be left out of a
-- per-model aggregate entirely rather than attributed by guesswork.
--
-- One row per (session, model), accumulated by the same best-effort
-- anthropic-proxy settle path that writes the ledger, in the SAME
-- statement (a CTE) so the two can never disagree: a session's breakdown
-- sums to its ledger, or neither was written. The proxy knows the model
-- of every call it settles (anthropic-stream returns it), so nothing here
-- is inferred.
--
-- A session that switched models mid-change has several rows, which is
-- the point: the reader attributes the whole change to the model that
-- spent the most in it rather than splitting one change into partial
-- ones.
--
-- Same three exclusions as the ledger (sync turns, zero-cost calls,
-- sessions with no id) and the same list-price, not-a-billing-record
-- posture. Tagged staging:private because it hangs off chat_sessions,
-- which is private: a public table must never carry a foreign key into
-- a private one.
CREATE TABLE IF NOT EXISTS chat_session_agent_model_costs (
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  model         VARCHAR(128) NOT NULL,
  cost_cents    NUMERIC(12,4) NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, model)
);
COMMENT ON TABLE chat_session_agent_model_costs IS 'staging:private';

-- #58: snapshot the vote threshold that was in effect at the moment a PR
-- merged. The "majority" needed to merge is computed live from the active-
-- user set (services/active-users.js getActiveUserStats) and is never
-- otherwise persisted, so the merged-PR vote pill used to be rendered
-- against the *current* majority — its denominator drifted as the app's
-- active-user count changed ("3 / 3" at merge could later read "3 / 5").
-- These two columns freeze the at-merge numbers so the pill (and a
-- tooltip) can show the true historical threshold:
--   votes_required        = the majority threshold needed to merge
--   active_users_at_merge = the active-user count the threshold was
--                           derived from (the "/ M" denominator context)
-- Both set by the merge-followups machine at the moment the PR lands
-- (vote-driven, admin force-merge, and revert-PR paths all flow through
-- there). NULL for rows merged before these columns existed; the boot-time
-- backfill in db/migrate.js reconstructs them from the merge announcement
-- message's "(yes/active votes)" figure where possible, and the frontend
-- falls back to the live majority for any that remain NULL. Covered by the
-- table-level staging:private comment, so they are scrubbed from staging
-- clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS votes_required        INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_users_at_merge INTEGER;

-- #3234: the electorate a proposal's vote OPENED with. The threshold is
-- still computed live and merge rules do not read this column; it is shown
-- only, so a voter can see the goalpost moved ("was N when voting opened")
-- when members joined or left mid-vote. Set where a row becomes 'promoted'
-- (routes/votes.js promote and the promote-on-import path) from the same
-- governance.getElectorate count the gate uses. NULL for rows promoted
-- before it existed, which show no note.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_users_at_promote INTEGER;

-- #788: "explicit approval" flag — this proposal's diff changes a
-- protected block in dapp.json (`admins`, `governance`, `visibility`,
-- `platform_env` or `secrets`; services/explicit-approval.js), so the
-- TIME-BASED merge paths are switched off for it:
-- no minimum visibility window, no lazy-consensus "silence is consent"
-- auto-merge. The app's NORMAL approval rules are otherwise untouched
-- (same threshold, same electorate, same at-least-N / invited-approver
-- configuration, same contested handling) — the proposal merges the
-- moment its normal threshold is met by votes actually cast. The
-- rejection countdown and the stale-PR sweep behave exactly as they do
-- for any other proposal on that app. Implemented as the pure
-- applyNoTimerMerge modifier in services/governance.js.
-- A flagged proposal ALSO needs at least one qualifying Yes from someone
-- other than its author whenever the app's community has more than one
-- member (the member floor, services/governance.js applyNoTimerMerge), and
-- an app admin can no longer force-merge it.
--   requires_explicit_approval : NULL = not computed yet (the stale-PR
--     sweeper backfills), FALSE = ordinary proposal, TRUE = flagged.
--   explicit_approval_reason   : which block flagged it: 'admins',
--     'governance', 'visibility', 'platform_env' or 'secrets'. ONE value,
--     the primary block in that order, when a proposal touches several:
--     every surface says one sentence, and the joined list would not fit
--     the column (the full list rides on the merge debug step).
-- Stamped at promote, at manifest-PR creation, and on every head change
-- (native new-commit vote reset + imported-PR head sync);
-- re-verified authoritatively by the merge gate (evaluateMergeGate).
-- Covered by the table-level staging:private comment.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS requires_explicit_approval BOOLEAN;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS explicit_approval_reason   VARCHAR(32);
-- The platform's own manifest PRs that were open before visibility,
-- governance and secret-declaration PRs were flagged at creation. Their
-- branch prefix says what they change (services/rename-pr.js), so they are
-- stamped here rather than left to merge on a timer until the merge gate's
-- live re-check reaches them. Idempotent: a stamped row is skipped, so
-- this touches nothing after its first boot.
UPDATE chat_sessions
   SET requires_explicit_approval = TRUE,
       explicit_approval_reason = CASE
         WHEN branch_name LIKE 'visibility/%' THEN 'visibility'
         WHEN branch_name LIKE 'governance/%' THEN 'governance'
         WHEN pr_title LIKE 'Declare platform variable%' THEN 'platform_env'
         ELSE 'secrets'
       END
 WHERE status IN ('promoted', 'merging')
   AND requires_explicit_approval IS NOT TRUE
   AND (branch_name LIKE 'visibility/%'
     OR branch_name LIKE 'governance/%'
     OR branch_name LIKE 'secret-declare/%');

CREATE TABLE IF NOT EXISTS chat_session_specs (
  id                  SERIAL PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  content             TEXT    NOT NULL,
  built_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  commit_sha          VARCHAR(40),
  pr_number           INTEGER,
  shared_to_group_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_specs_session
  ON chat_session_specs (session_id, version DESC);
-- #3699: the version's HTML document when it was written as one (see
-- chat_sessions.spec_html); content is then its markdown copy.
ALTER TABLE chat_session_specs ADD COLUMN IF NOT EXISTS content_html TEXT;

-- #86: private spec shares. Each row grants ONE user read access to ONE
-- frozen spec version (the "Share to user" button on the dev-session
-- spec viewer). This table is the authorization source of truth for the
-- widened read gate on GET /api/sessions/:id/specs/:version — the
-- matching 'spec_shared' notification row is just UI. The unique
-- constraint makes re-shares idempotent (and is what keeps a recipient
-- from being re-notified per spec version). Independent of
-- chat_session_specs.shared_to_group_at: a later group share simply
-- makes these rows redundant, never conflicting.
CREATE TABLE IF NOT EXISTS chat_session_spec_user_shares (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_spec_user_shares_recipient
  ON chat_session_spec_user_shares (recipient_id, created_at DESC);

-- Allow group-chat messages to carry structured payloads (spec_share
-- card metadata today; future: PR previews, system-link metadata, etc.)
-- without overloading the free-form `content` field.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- #194: thread scoping for chat_messages. NULL thread_type = general
-- chat (all pre-existing rows; no backfill needed). thread_type is one
-- of 'issue' | 'session' | 'governance'; thread_ref is, respectively,
-- the GitHub issue number (consistent with
-- issue_bounties.github_issue_number keying), chat_sessions.id (PR
-- proposals), or the internal issues.id (governance proposals). No FK
-- on thread_ref — GitHub issue numbers aren't a local table; session /
-- governance refs are validated server-side at post time (ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_type VARCHAR(16);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_ref INTEGER;

-- Message editing: NULL = never edited; a timestamp = the most recent edit
-- time (rendered as the "edited" marker's tooltip). No backfill needed —
-- all pre-existing rows are unedited (matches the metadata/thread_type
-- precedent). Only the original author may set it (enforced in the WS
-- 'edit' handler, src/services/ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- #2236: how a message reached the thread. NULL = a person typing in the
-- browser (every pre-existing row; no backfill). 'agent' = posted on the
-- author's behalf by a coding agent through the Homeroom MCP connector, so
-- the thread can say so beside the name. Derived server-side from the
-- request's connector credential (routes/chat.js), never from the body.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS posted_via VARCHAR(16);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (app_id, thread_type, thread_ref, id)
  WHERE thread_type IS NOT NULL;

-- #2387 (messages overhaul), app channels.
--
-- Soft delete: the author takes back one of their own messages. The row
-- stays so the transcript keeps its shape (a placeholder where the message
-- was, and a reply thread under it keeps its root), but its content is
-- cleared on the row itself and its attachments, reactions, bookmarks and
-- notifications are removed in the same transaction
-- (services/app-chat.js deleteOwnMessage). NULL = live, every existing row.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Reply threads reuse the #194 thread scoping: thread_type 'message' with
-- thread_ref = the root chat_messages.id, a general-stream row of the same
-- app. idx_chat_messages_thread above already serves "one thread's
-- replies" and "the replies under this page of roots".
--
-- The general stream had no index of its own: history pages, the Messages
-- list's latest-message preview and the per-viewer unread count all read
-- "this app's general stream above/below an id", which is exactly this.
CREATE INDEX IF NOT EXISTS idx_chat_messages_general
  ON chat_messages (app_id, id)
  WHERE thread_type IS NULL;

-- "Apps this person has posted in" — one of the activity sources that puts
-- a non-member app in the Messages list's "more" section (#2967).
CREATE INDEX IF NOT EXISTS idx_chat_messages_author
  ON chat_messages (user_id, app_id)
  WHERE user_id IS NOT NULL;

-- #25: emoji reactions on group-chat messages (WhatsApp-style, but
-- Slack-model: a user may add multiple distinct emoji to one message,
-- hence UNIQUE(message_id, user_id, emoji) rather than per-user). Toggled
-- via the per-app chat WebSocket ('react' message in src/services/ws.js).
CREATE TABLE IF NOT EXISTS message_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions(message_id);
-- #2967: "apps this person has reacted in", the other chat activity source
-- for the Messages list's "more" section. The UNIQUE index leads with
-- message_id, so it cannot answer a per-user read.
CREATE INDEX IF NOT EXISTS message_reactions_user_idx ON message_reactions(user_id);

-- #1280: personal bookmarks on group-chat messages. A user saves any
-- message they can read (the bookmark button in the message header,
-- public/js/group-chat.js); saved messages render in a pinned "Saved"
-- section at the TOP of the notifications drawer until unsaved — from
-- the message itself, or from that section. Toggled over REST
-- (src/routes/chat.js), not the chat WebSocket: a bookmark is private to
-- one user, so there is nothing to broadcast to the app's other viewers.
--
-- One row per (user, message); the UNIQUE constraint is what makes the
-- save path an idempotent upsert. Tagged `staging:private` below for the
-- same reason `notifications` is — it is one person's private feed, and
-- a staging clone must not carry it. The staging preview is fed by the
-- request-time `?demo=1` mock in src/routes/notifications.js instead.
CREATE TABLE IF NOT EXISTS message_bookmarks (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, message_id)
);
-- The drawer's section reads "this user's saves, newest first", which is
-- exactly this index; the message-side lookup rides the UNIQUE index.
CREATE INDEX IF NOT EXISTS message_bookmarks_user_idx
  ON message_bookmarks (user_id, created_at DESC);

-- #2387: one person's read position in one app's general stream. A
-- watermark, not a per-message receipt: every general-stream message with
-- an id above `last_read_message_id`, from somebody else, not deleted and
-- not from someone the reader blocked, is unread (services/app-chat.js).
--
--   POST /api/apps/:slug/messages/read    moves it FORWARD only;
--   POST /api/apps/:slug/messages/unread  moves it BACK, to just before
--                                         the message named;
--   posting in the general stream moves the poster's forward to their own
--   message, the way sending in Slack marks the channel read.
--
-- A missing row is created lazily at the app's newest general-stream id the
-- first time the Messages list reads it, so the feature starts at zero
-- unread for everybody instead of at "everything ever said". No FK to the
-- message: a cursor is a position, and ids are monotonic.
--
-- staging:private (below): where each person has read up to is personal
-- reading history, the same reason `notifications` and `message_bookmarks`
-- are. Private-to-public FKs (apps, users) are the permitted direction.
CREATE TABLE IF NOT EXISTS app_chat_reads (
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_chat_reads_user ON app_chat_reads (user_id);
COMMENT ON TABLE app_chat_reads IS 'staging:private';

-- Issues (mirrored to GitHub Issues). `kind` discriminates general issues from
-- structured proposals like 'rename' (see src/routes/issues.js). `payload`
-- carries the proposal-specific data (e.g. { newName }).
CREATE TABLE IF NOT EXISTS issues (
  id                  SERIAL PRIMARY KEY,
  app_id              INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number INTEGER,
  title               VARCHAR(512) NOT NULL,
  description         TEXT,
  kind                VARCHAR(32) NOT NULL DEFAULT 'general',
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status              VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'general';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Applied close-issue proposals surface in the Completed stream
-- (GET /api/apps/:slug/merged interleaves them with merged PRs); this
-- partial index keeps that keyset scan cheap without widening the table's
-- general indexing.
CREATE INDEX IF NOT EXISTS idx_issues_close_completed
  ON issues (app_id, created_at DESC, id DESC)
  WHERE kind = 'close_issue' AND status = 'closed';

CREATE TABLE IF NOT EXISTS issue_votes (
  id         SERIAL PRIMARY KEY,
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(issue_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_issue_votes_user ON issue_votes (user_id, created_at DESC);

-- Fleet maintenance campaigns (#853's generalization): a platform-level
-- governance proposal (issues.kind='maintenance_campaign' on the
-- self-hosted app) that, once its vote passes, runs a sequential AI loop
-- over every child app repo, opening one maintenance PR per app
-- (chat_sessions.source='maintenance'). The campaign row is created by
-- the governance machine's apply (src/workflow/governance-proposal/), which
-- starts the campaign machine (src/workflow/campaign/); both tables are that
-- machine's projections (its ownership guard is below, with the others).
--   status: 'running'   = opening proposals (the campaign machine's
--                         `running`; src/workflow/campaign/);
--           'done'      = every target has an outcome (pr_open / skipped /
--                         failed) — merging is the proposals', not here;
--           'cancelled' = an admin stopped it (`stopped`).
CREATE TABLE IF NOT EXISTS maintenance_campaigns (
  id            SERIAL PRIMARY KEY,
  issue_id      INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  title         VARCHAR(300) NOT NULL,
  instructions  TEXT NOT NULL,
  target_filter JSONB,
  status        VARCHAR(32) NOT NULL DEFAULT 'running',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- One row per (campaign, target app), the targets fixed when the campaign
-- starts. The campaign machine's projection of each app:
--   pending -> running (being changed, then put up for a vote) -> pr_open | skipped | failed
--   pending | running -> stopped (a stop reached it first)
-- What came of a proposal (merged, closed) is read off its session, never
-- written here ('merged' is only on rows an older release's drain wrote).
-- 'skipped' = the AI concluded the app doesn't need the change;
-- 'failed'  = LLM/GitHub error or a refused promote, `error` carries the
--             reason; the dashboard's retry asks the machine again.
CREATE TABLE IF NOT EXISTS maintenance_campaign_apps (
  id          SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES maintenance_campaigns(id) ON DELETE CASCADE,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  state       VARCHAR(32) NOT NULL DEFAULT 'pending',
  error       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, app_id)
);
-- The lease an older release's driver held on a campaign (its runner and
-- until when) and the runner that claimed each app row. Read only during a
-- rollout: the campaign machine adopts a campaign once no older driver
-- holds it and fences it off ('workflow', 'infinity'). Dropped once no
-- release older than the campaign machine can run.
ALTER TABLE maintenance_campaigns ADD COLUMN IF NOT EXISTS runner_id TEXT;
ALTER TABLE maintenance_campaigns ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE maintenance_campaign_apps ADD COLUMN IF NOT EXISTS runner_id TEXT;

-- PR votes
CREATE TABLE IF NOT EXISTS pr_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_pr_votes_user ON pr_votes (user_id, created_at DESC);

-- Revision-scoped approvals for every GitHub PR proposal. Imported proposals
-- use imported_pr_head_sha; native proposals use reviewed_head_sha. A later
-- push re-opens approval and the merge gate counts only votes cast against
-- the current reviewed revision. NULL remains valid for historical rows until
-- their next promote, vote, or merge reconciliation. Append-only; safe on boot.
ALTER TABLE pr_votes ADD COLUMN IF NOT EXISTS head_sha VARCHAR(40);

-- #955: provenance for commits the PLATFORM itself pushed onto a proposal
-- branch (today only the MODE=sync "merge origin/main" turn — clean or
-- Claude-resolved). A proposal's votes are pinned to the exact reviewed
-- commit, so without this record the platform's own conflict-resolution
-- commit is indistinguishable from an author push and wipes the tally.
--
-- Authenticity comes from "we pushed this SHA", never from commit message,
-- author identity, or merge-commit shape — all of which an author can
-- reproduce locally, which would turn vote preservation into a governance
-- bypass. first_parent_sha lets the reconciler walk a chain of stacked
-- platform commits back to the reviewed head without re-reading GitHub;
-- prior_reviewed_head_sha records what the review was pinned to at push
-- time (audit only). Append-only; rows cascade with the session.
--
-- Deliberately NOT tagged 'staging:private': it holds no user content and no
-- credential — just commit ids the platform authored. It still arrives empty
-- in a staging clone, as a transitive FK child of the private chat_sessions
-- (db-manager.js truncates those CASCADE and its recursive discovery finds
-- this table automatically), exactly like its sibling pr_votes.
CREATE TABLE IF NOT EXISTS session_platform_pushes (
  id                      SERIAL PRIMARY KEY,
  session_id              INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sha                     VARCHAR(40) NOT NULL,
  first_parent_sha        VARCHAR(40),
  prior_reviewed_head_sha VARCHAR(40),
  kind                    VARCHAR(24) NOT NULL DEFAULT 'sync_main',
  sync_result             VARCHAR(16),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_session_platform_pushes_session
  ON session_platform_pushes (session_id, sha);

-- Community-voted "priority" + "assigned person" on issues and PR
-- proposals. ONE unified table because both fields share identical
-- voting mechanics (one movable vote per user per field per card; the
-- top-voted value is what the card shows). target_ref points at the
-- GitHub issue NUMBER when target_type='issue' (mirroring issue_bounties,
-- which is keyed by (app_id, github_issue_number) because the Dev feed
-- lists repo GitHub issues that may have no internal `issues` row) and at
-- the chat_sessions.id (session id) when target_type='proposal'.
-- value holds 'low'|'medium'|'high' for priority, one of a fixed category
-- slug set (feature|bug|improvement|design|docs|chore) for category, or the
-- typed display name (raw casing) for assignee — assignee dedupe is
-- case-insensitive at read time, never restricted to registered users.
-- NOT staging:private:
-- the tally is a public governance-style signal (closer to issue_votes
-- than to the privacy-flavoured bounty/kudos ledgers), so leaving it
-- copyable lets staging previews show real seeded data.
CREATE TABLE IF NOT EXISTS topic_attribute_votes (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  target_type VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  target_ref  INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  field       VARCHAR(16) NOT NULL,   -- 'priority' | 'assignee' | 'category' | 'theme'
  value       TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, target_type, target_ref, field, user_id)
);
-- Per-card tally read (group by value within one target+field).
CREATE INDEX IF NOT EXISTS idx_topic_attribute_votes_target
  ON topic_attribute_votes (app_id, target_type, target_ref, field);

-- #780: per-app registry of CUSTOM category options, listed under the six
-- built-in slugs (feature|bug|improvement|design|docs|chore) in the category
-- chip's dropdown and in the kanban / PM filter bar. Typing a new category
-- in that dropdown registers a row here (scoped to ONE app) and casts the
-- typer's vote for it in the same request — "suggesting" and "voting" stay
-- the same operation, mirroring the free-text assignee field.
--   slug  — lowercased dedupe key; ALSO the literal string written into
--           topic_attribute_votes.value, so a custom category tallies
--           byte-for-byte like a built-in one and needs no vote migration.
--   label — the display casing as FIRST typed ("iOS", "UX"), so a later
--           "ios" votes for the same option without rewriting the label.
-- NOT staging:private — like topic_attribute_votes this is a shared,
-- governance-style signal everyone in the app sees, so it must copy into
-- staging clones.
CREATE TABLE IF NOT EXISTS app_topic_categories (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,           -- lowercase dedupe key + vote value
  label       TEXT NOT NULL,           -- display casing as first typed
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, slug)
);

-- The app's ONE category vocabulary, and the registry behind it.
--
-- #2332 added this as a SECOND axis ("themes", what the work is about, beside
-- categories, what kind of work it is). That was the wrong shape: the product
-- had always called this grouping a category — the card chip's own tooltip
-- read "Category: {name}" while the tab above it said "By theme" — and two
-- lists is what the merge was asked to end. There is now ONE list. Every
-- non-built-in category lives here, whoever minted it: the model drafting the
-- board's grouping, or a member typing a name.
--
-- The six BUILT-IN slugs (feature|bug|improvement|design|docs|chore) stay
-- hardcoded in services/topic-attributes.js, as they always were — they need
-- stable colours and labels and are mirrored on the front end. They are
-- offered alongside these rows, never duplicated into them, and discovery is
-- given them so it drafts AROUND them rather than redrawing them.
--
-- GENERATIONAL, not append-only, and that is why this is its own table rather
-- than more rows in app_topic_categories above. Discovery re-drafts an app's
-- entire vocabulary every run (daily, or at a tenth of the board's churn),
-- while app_topic_categories only ever INSERTs and is capped at 24. Pointing
-- the model's churn at an append-only registry would exhaust that cap within
-- weeks, after which the app could never gain another category. So:
--   * discovery may MINT rows and RETIRE ones it no longer draws;
--   * retirement is a `retired_at` stamp, never a DELETE, so the votes and
--     placements that point at a category can never dangle;
--   * `pinned_at` is set the moment a HUMAN votes for it, and a pinned row is
--     never retired — it rides into the next discovery carrying
--     `pinned: true`, and services/workshop-themes.js re-adds it after the
--     call whatever the model answered. The prompt is told to keep it; the
--     code does not rely on the prompt obeying.
--   * the cap counts LIVE rows (retired_at IS NULL) only, so model churn
--     stops consuming the budget members' own categories need.
--
-- category_key is slugify()'d text and IS the literal value written into
-- topic_attribute_votes.value, so a member typing "Signing in" tallies
-- byte-for-byte with the model's own `signing-in` id.
--
-- NOT staging:private — like topic_attribute_votes and app_topic_categories
-- this is a shared, governance-style signal everyone in the app sees.

-- Renamed from #2332's app_theme_registry / theme_key. Guarded so boot is
-- idempotent either way: an existing deployment renames in place and keeps
-- its rows, a fresh one falls straight through to the CREATE below.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'app_theme_registry')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = 'app_category_registry')
  THEN
    ALTER TABLE app_theme_registry RENAME TO app_category_registry;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'app_category_registry' AND column_name = 'theme_key')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'app_category_registry' AND column_name = 'category_key')
  THEN
    ALTER TABLE app_category_registry RENAME COLUMN theme_key TO category_key;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_category_registry (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  category_key TEXT NOT NULL,          -- slugified dedupe key + vote value
  label        TEXT NOT NULL,          -- display casing, as drafted or typed
  description  TEXT NOT NULL DEFAULT '',
  icon         TEXT NOT NULL DEFAULT '',-- one emoji, or '' for the initial
  origin       VARCHAR(8) NOT NULL DEFAULT 'ai',  -- 'ai' | 'member'
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pinned_at    TIMESTAMPTZ,            -- first human vote; pinned is forever
  retired_at   TIMESTAMPTZ,            -- dropped by a draft; never deleted
  UNIQUE(app_id, category_key)
);
-- The read every list, cap check and discovery hand-off makes: this app's
-- live vocabulary. Partial, because retired rows are dead weight on it.
CREATE INDEX IF NOT EXISTS idx_app_category_registry_live
  ON app_category_registry (app_id, created_at) WHERE retired_at IS NULL;
DROP INDEX IF EXISTS idx_app_theme_registry_live;

-- ONE registry: fold app_topic_categories' rows in, so the custom categories
-- members typed before #2332 are offered from the same place as everything
-- since. They arrive PINNED and origin 'member' — a person chose each one, so
-- no draft may retire it. app_topic_categories is left in place, unread, as
-- the record of where they came from; nothing writes to it any more.
INSERT INTO app_category_registry (app_id, category_key, label, origin, created_by, created_at, pinned_at)
SELECT c.app_id, c.slug, c.label, 'member', c.created_by, c.created_at, c.created_at
  FROM app_topic_categories c
 ON CONFLICT (app_id, category_key) DO NOTHING;

-- ONE field: #2332's `theme` votes become `category` votes. Where the same
-- member already holds a category vote on the same card the EXISTING vote
-- stands — they expressed both, and the older one is the one they have lived
-- with — so the theme row is dropped rather than overwriting it. Both
-- statements are no-ops once no `theme` rows remain.
UPDATE topic_attribute_votes v
   SET field = 'category'
 WHERE v.field = 'theme'
   AND NOT EXISTS (
     SELECT 1 FROM topic_attribute_votes o
      WHERE o.app_id = v.app_id AND o.target_type = v.target_type
        AND o.target_ref = v.target_ref AND o.field = 'category'
        AND o.user_id IS NOT DISTINCT FROM v.user_id
   );
DELETE FROM topic_attribute_votes WHERE field = 'theme';

-- #4417: TOPICS. On screen and in dapp.json a topic is a lasting
-- conversation about one part of a project, with the requests about that
-- part filed under it. Inside the platform it is a CATEGORY ROW with
-- origin = 'topic' (the word "topic" already means one request or proposal
-- here: topic_attribute_votes, services/topic-attributes.js), and its
-- channel is a chat_messages thread of type 'category' whose thread_ref is
-- this row's id. dapp.json's `topics` array is the only writer
-- (services/app-manifest.js reconcileAppTopics), on the rebuild a merged
-- topics PR triggers and, for the platform's own app, at boot.
--
--   topic_handle   the channel's name (#onboarding); a rename may change it
--   topic_aliases  handles it had before, so an old link keeps working
--   topic_state    'live' | 'archived' | 'merged'. A retired topic also
--                  carries retired_at, so every reader of the live
--                  vocabulary leaves it out with no change of its own.
--   merged_into    the surviving topic's category_key, when merged
--   merged_at      when the merge applied: where the channel's history draws
--                  its card (no chat_messages row is written for it)
--   topic_order    the array's order, which is the list's order
--
-- A topic row is PINNED, so a discovery never retires it, and its
-- category_key is dapp.json's `id`, set once: the literal value a category
-- vote carries, so no rename moves a vote.
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS topic_handle TEXT;
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS topic_aliases TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS topic_state VARCHAR(8);
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS merged_into TEXT;
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS topic_order INTEGER;
-- topic_figures: dapp.json's `figures` for the topic, the numbers its
-- channel shows above the room (services/topic-figures.js). Written by the
-- same reconcile, so changing them is a proposal like the topic itself.
ALTER TABLE app_category_registry ADD COLUMN IF NOT EXISTS topic_figures TEXT[] NOT NULL DEFAULT '{}';
-- The read the places list, the channel lookup and the tally's exclusion
-- make: one app's topics, in order.
CREATE INDEX IF NOT EXISTS idx_app_category_registry_topics
  ON app_category_registry (app_id, topic_order)
  WHERE origin = 'topic';

-- #4417: one person's read position in one topic's channel, for its unread
-- count on the places list. It mirrors app_chat_reads (the general stream's
-- watermark) one level down: every message of that 'category' thread with
-- an id above `last_read_id`, from somebody else, not deleted and not from
-- someone the reader blocked, is unread (services/app-chat.js). A missing
-- row is created at the channel's newest message the first time the list is
-- read for a member, so a topic starts at zero unread. staging:private for
-- the reason app_chat_reads is: personal reading history.
CREATE TABLE IF NOT EXISTS app_category_chat_reads (
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES app_category_registry(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, category_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_category_chat_reads_user ON app_category_chat_reads (user_id);
COMMENT ON TABLE app_category_chat_reads IS 'staging:private';

-- #613: manual drag-and-drop ordering of cards WITHIN a Dev-board kanban
-- column. The board's default order is derived (recency / merge-priority);
-- this table is an OVERLAY: cards whose identity appears here sort first,
-- by `position` asc, and everything else keeps the derived order. Keyed the
-- same way as topic_attribute_votes (heterogeneous cards addressed by a
-- (type, ref) pair) because a column mixes GitHub issues (ref = issue
-- NUMBER) with promoted PR proposals (ref = chat_sessions.id) and governance
-- proposals (ref = issues.id). column_key ∈ 'issues' | 'review' (the two
-- shared columns this feature covers; In progress is per-viewer and Done is
-- paginated, so both are out of scope). One movable order per app+column;
-- writes REPLACE the whole (app_id, column_key) set with a dense 0..N-1
-- sequence (last-write-wins). NOT staging:private — like topic_attribute_votes
-- this is a shared, governance-style signal that everyone sees, so it must
-- copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_board_card_order (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  column_key  VARCHAR(16) NOT NULL,   -- 'issues' | 'review'
  card_type   VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal' | 'gov'
  card_ref    INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id | issues.id
  position    INTEGER NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, column_key, card_type, card_ref)
);
-- Per-column ordered read (position asc within one app+column).
CREATE INDEX IF NOT EXISTS idx_dev_board_card_order_col
  ON dev_board_card_order (app_id, column_key, position);

-- Manual drag-and-drop ordering of cards WITHIN one person's section of the
-- Dev board's PM view ("tasks by assignee"). Sibling of dev_board_card_order,
-- but keyed by the case-folded ASSIGNEE instead of a kanban column: the PM
-- view groups cards by their top-voted assignee (see topic-attribute votes),
-- so a manual order is scoped to a person, not a column. Same OVERLAY model —
-- cards whose identity appears here sort first by `position` asc, everything
-- else keeps the client's derived recency order (see _applyManualOrder in
-- public/js/app-view.js). assignee_key = lower(display name), matching
-- topic-attributes.groupKey so it lines up with the rendered section. A PM
-- section only ever holds GitHub issues (card_ref = issue NUMBER) and promoted
-- PR proposals (card_ref = chat_sessions.id) — never governance cards, which
-- carry no assignee. One movable order per (app_id, assignee_key); writes
-- REPLACE the whole set with a dense 0..N-1 sequence (last-write-wins). NOT
-- staging:private — like dev_board_card_order it's a shared, governance-style
-- signal everyone sees, so it must copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_pm_card_order (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  assignee_key VARCHAR(64) NOT NULL,   -- lower(assignee display name)
  card_type    VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  card_ref     INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  position     INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, assignee_key, card_type, card_ref)
);
-- Per-person ordered read (position asc within one app+assignee).
CREATE INDEX IF NOT EXISTS idx_dev_pm_card_order_key
  ON dev_pm_card_order (app_id, assignee_key, position);

-- LLM usage tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

-- #361: dedicated "system tokens" daily ledger for platform-driven
-- merge-conflict / sync-with-main resolution turns. One row per day (not
-- per user — this spend isn't attributable to a person). Mirrors the
-- llm_usage upsert shape. Kept separate from llm_usage so this
-- housekeeping spend never pollutes per-user analytics or the global
-- cap aggregation. Written via limits.recordSystemSpend, gated via
-- limits.checkSystemBudget against system_tokens_daily_limit_cents.
CREATE TABLE IF NOT EXISTS system_token_usage (
  date       DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- #119: split daily spend by who paid Anthropic.
--   total_cost_cents = platform-key spend (drives the daily caps)
--   byok_cost_cents  = spend billed to the user's own Anthropic key
--                      (display only — never considered by any cap)
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS byok_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0;

-- #1088: stamped the first time — for this UTC day — the owner is TOLD
-- that their own Anthropic key took over once the free daily allowance
-- ran out. The proxy's per-turn registry flag only made the notice
-- once-per-turn, so it re-fired on every chat after credits ran out.
-- Claimed race-free by limits.claimByokSwitchNotice (a conditional
-- upsert); NULL means "not yet told today". Rides on the row's `date`,
-- so it expires exactly when the credits themselves reset — no sweeper.
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS byok_notice_at TIMESTAMPTZ;

-- Platform-level admin-tunable settings. Currently only used for the
-- daily LLM spend caps; designed as a generic key/value store so future
-- admin knobs can land here without another migration. Values are
-- TEXT so callers can interpret per-key (parseInt for cents, etc.).
-- Read via src/services/limits.js with a 10s in-process cache;
-- writes from /api/admin/limits invalidate the cache.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Seed defaults that match the legacy hardcoded values in
-- src/routes/sessions.js (USER_DAILY_LIMIT_CENTS=2500, GLOBAL=20000)
-- so a fresh deploy preserves the prior behavior. ON CONFLICT DO
-- NOTHING means existing operator-set values survive every boot.
INSERT INTO platform_settings (key, value) VALUES
  ('user_daily_limit_cents',   '2500'),
  ('global_daily_limit_cents', '20000'),
  -- #361: separate "system tokens" budget that funds platform-driven
  -- merge-conflict / sync-with-main resolution turns. Defaults to $25/day.
  ('system_tokens_daily_limit_cents', '2500')
ON CONFLICT (key) DO NOTHING;

-- #1788: the platform-default per-user WEEKLY cap. #2571 makes it the ONLY
-- per-user cap (the daily one is switched off in src/services/limits.js) and
-- sets the code default to $50 a week, seeded as a literal rather than as a
-- multiple of the daily default. Still ON CONFLICT DO NOTHING, and still the
-- only statement that writes this key on boot: an operator-set value — which
-- is what production runs on, set from the admin Limits page — survives every
-- deploy untouched. No migration rewrites it.
INSERT INTO platform_settings (key, value) VALUES
  ('user_weekly_limit_cents', '5000')
ON CONFLICT (key) DO NOTHING;

-- One-shot backfill of users.weekly_limit_cents for everyone who already
-- holds a DAILY override. Without it, a raised daily cap would collide with
-- the platform weekly default the first time the weekly gate ran — a user
-- on $120/day would be cut off partway through Tuesday by a $140 week.
-- Seven times their own daily cap preserves exactly what each of them could
-- already spend. Guarded by a marker row so it runs EXACTLY ONCE, the same
-- way app_quota_migrated above is: a re-runnable UPDATE would re-clobber
-- any weekly cap an admin later lowers by hand. Rows with no daily override
-- are left NULL and fall through to the platform default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'weekly_limit_backfilled') THEN
    UPDATE users
       SET weekly_limit_cents = daily_limit_cents * 7
     WHERE daily_limit_cents IS NOT NULL
       AND weekly_limit_cents IS NULL;
    INSERT INTO platform_settings (key, value)
      VALUES ('weekly_limit_backfilled', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- One-shot backfill of users.app_quota from the legacy can_create_apps
-- boolean. Guarded by a marker row in platform_settings so it runs EXACTLY
-- ONCE: a re-run-safe UPDATE keyed only on can_create_apps = TRUE would
-- re-clobber any quota an admin later resets to 0 for a still-enabled user.
-- Placed after both `apps` and `platform_settings` exist (this whole file
-- runs as one ordered statement). Mapping for existing enabled users:
--   can_create_apps = TRUE  → app_quota = GREATEST(5, <live app count>),
--     where live count = COUNT(*) of their non-errored apps. The floor of
--     5 guarantees no regression — nobody who could already create ends up
--     below the apps they already have. Admins are included (their quota is
--     cosmetic since they bypass enforcement) so the admin UI shows a
--     sensible number.
--   can_create_apps = FALSE → keep the numeric quota (now defaulting to 2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'app_quota_migrated') THEN
    UPDATE users u
       SET app_quota = GREATEST(5, (
             SELECT COUNT(*)::int FROM apps
              WHERE created_by = u.id AND status <> 'error'
           ))
     WHERE u.can_create_apps = TRUE;
    INSERT INTO platform_settings (key, value)
      VALUES ('app_quota_migrated', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- Notifications. Generic row format so we can add more `kind`s later
-- (PR approvals, etc). Currently 'mention' (group-chat @mention parser
-- in src/services/ws.js), 'kudos' (PR kudos give in src/routes/kudos.js),
-- 'reply' (#15 — someone quoted your message/PR in group chat;
-- chat_message_id points to the reply, set in src/services/ws.js),
-- 'reaction' (#25 — someone reacted to your message; chat_message_id is
-- the reacted message, `detail` holds the emoji), 'stale_pr' (a promoted
-- PR is going quiet, addressed to its author), 'pr_proposed' (a PR
-- was promoted for voting — session_id points to it; fanned out to the
-- app's active users + creator + favoriters in src/routes/votes.js),
-- 'session_done' (#161 — a dev-session turn finished after its owner
-- left; session_id points to the session), 'auto_solve_done' (#161 —
-- a headless auto-solve run finished; `detail` holds the outcome:
-- spec | code | spec_code | question | failed) and 'spec_shared' (#86 —
-- someone privately shared a spec version with you; session_id points
-- to the dev session, `detail` holds the version number as a string).
-- #2387 adds 'thread_reply': somebody replied in an app-chat reply thread
-- you started or replied in; chat_message_id is the new reply, whose
-- thread_ref is the thread's root message.
-- #4535 adds 'issue_thread_reply': somebody posted in a request's
-- discussion thread you filed or posted in; chat_message_id is the new
-- message, thread_ref the request's number and `detail` that number too.
-- #3181 adds 'session_stalled': a dev-session turn ended without finishing
-- (an error, a timeout, a lost worker, or a system pause mid-turn);
-- session_id points to the session, like 'session_done'.
-- #3952 adds 'issue_mention': somebody named you with @ in a request they
-- filed; `detail` holds its number, like 'issue_opened'.
CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  chat_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  source_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            VARCHAR(32) NOT NULL DEFAULT 'mention',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_recent
  ON notifications (user_id, created_at DESC);

-- Kudos notifications carry a chat_sessions reference so the notification
-- dropdown can navigate back to the PR (group-chat tab) and render the
-- PR's title in the preview. Added later than the rest of the column
-- set, so wrapped in IF NOT EXISTS for idempotent re-runs.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS session_id
  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE;
-- 5 October (Page Turners): a change that goes live or closes settles what
-- the bell still asks everybody about it at once
-- (notifications.settleDecidedChange), which reads by change, not by person.
CREATE INDEX IF NOT EXISTS idx_notifications_session
  ON notifications (session_id) WHERE session_id IS NOT NULL;

-- #25: free-form detail for a notification kind that needs a small extra
-- string. Today only 'reaction' uses it (the emoji someone reacted with);
-- kept generic + nullable so future kinds can reuse it.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail VARCHAR(32);
-- #2161: 'app_deleted' has no app row left to join (notifications.app_id
-- cascades with the app), so the deleted app's NAME rides in `detail`.
-- apps.name is VARCHAR(255); widening is metadata-only in Postgres and
-- re-running it is a no-op.
ALTER TABLE notifications ALTER COLUMN detail TYPE VARCHAR(255);

-- #4769: personal bookmarks on notifications. A user saves any
-- notification in their feed (the bookmark button at the right end of the
-- row, notifications-sheet.tsx); saved notifications render in the same
-- pinned "Saved" section at the TOP of the drawer as #1280's saved
-- messages, until unsaved — from the row itself, or from that section.
-- Toggled over REST (src/routes/notifications.js), not the chat
-- WebSocket: a save is private to one user, so there is nothing to
-- broadcast.
--
-- One row per (user, notification); the UNIQUE constraint is what makes
-- the save path an idempotent insert. Deleting the notification deletes
-- the save (the FK cascade), and a save never changes the notification's
-- read state. Tagged `staging:private` below for the same reason
-- `notifications` is — one person's private feed — with the staging
-- preview fed by the request-time `?demo=1` mock in
-- src/routes/notifications.js instead.
CREATE TABLE IF NOT EXISTS notification_bookmarks (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, notification_id)
);
-- The drawer's Saved section reads "this user's notification saves,
-- newest first", which is exactly this index; the per-notification
-- lookup rides the UNIQUE index.
CREATE INDEX IF NOT EXISTS notification_bookmarks_user_idx
  ON notification_bookmarks (user_id, created_at DESC);

-- #1559: grant existing accounts at least two slots once, preserving higher
-- allowances. A later explicit admin reduction must survive every restart.
-- Persist the notification in the same migration so offline users see it too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'app_allowance_default_two_migrated') THEN
    INSERT INTO notifications (user_id, kind, detail)
      SELECT id, 'app_quota_changed', app_quota::text || ':2'
        FROM users WHERE app_quota < 2;
    UPDATE users SET app_quota = 2 WHERE app_quota < 2;
    INSERT INTO platform_settings (key, value)
      VALUES ('app_allowance_default_two_migrated', 'true');
  END IF;
END $$;

-- #1405 path B: a coding agent driving the connector telling the platform it
-- has asked the user something and is now waiting.
--
-- WHY THIS IS STORED AT ALL, rather than notifying immediately: if you are at
-- the keyboard you will answer in seconds, and a push for that is pure noise.
-- So the arming call records an intent to notify at `notify_at`, and a sweeper
-- fires only the rows still live when their moment arrives.
--
-- WHY THE PLATFORM CANNOT WORK THIS OUT ITSELF: it sees MCP calls, and silence
-- from a connector is ambiguous between "waiting for you", "busy working",
-- "session over" and "tab closed" — a coding agent routinely runs for many
-- minutes with no connector call at all. The agent is the only party that
-- knows, so it has to say so.
--
-- ONE-SHOT, deliberately. `fired_at` is stamped when the sweeper sends, and a
-- fired row is never reconsidered. Clearing depends on the agent calling back,
-- which it may forget; one-shot means a forgotten clear costs one stray
-- notification rather than a repeating alarm. That bound is what makes the
-- unreliable half of this feature acceptable.
--
-- `question` is the agent's own text. It is what the user was asked, so it is
-- personal content and this table is staging:private for the same reason the
-- messages tables are.
CREATE TABLE IF NOT EXISTS connector_input_waits (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  question    TEXT NOT NULL DEFAULT '',
  client_id   TEXT,
  armed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notify_at   TIMESTAMPTZ NOT NULL,
  cleared_at  TIMESTAMPTZ,
  fired_at    TIMESTAMPTZ
);
COMMENT ON TABLE connector_input_waits IS 'staging:private';

-- The sweeper's only query: rows that are due, not cleared and not yet fired.
CREATE INDEX IF NOT EXISTS connector_input_waits_due_idx
  ON connector_input_waits (notify_at)
  WHERE cleared_at IS NULL AND fired_at IS NULL;

-- At most ONE live wait per user. Arming twice supersedes rather than stacks:
-- an agent that asks a second question before the first fired should not
-- produce two pushes, and a user with several sessions running still only
-- needs telling once that something wants them.
CREATE UNIQUE INDEX IF NOT EXISTS connector_input_waits_live_idx
  ON connector_input_waits (user_id)
  WHERE cleared_at IS NULL AND fired_at IS NULL;

-- Per-app environment secrets. Values are AES-256-GCM encrypted via
-- src/services/secrets.js (keyed off DATA_ENCRYPTION_KEY), serialized as
-- "v1:<iv>:<tag>:<ct>" — same scheme used for users.anthropic_key_enc.
--
-- A dapp declares which keys it needs in `dapp.json` at its repo root
-- (see src/services/app-manifest.js). Stored values for any `required`
-- key listed there must be present at deploy time, otherwise the
-- deploy is blocked (createApp flips status to 'awaiting_secrets';
-- deployProduction throws with `missingSecrets`).
--
-- value_last4 is a redacted preview the UI can show without a decrypt
-- round-trip (e.g. "ut1…abcd"). Sensitive values store NULL here so the
-- UI never shows even a fragment.
CREATE TABLE IF NOT EXISTS app_secrets (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key         VARCHAR(128) NOT NULL,
  value_enc   TEXT NOT NULL,
  value_last4 VARCHAR(8),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, key)
);

-- Self-hosting: the platform itself appears as one row in `apps` with
-- self_hosted=TRUE. The seed at boot inserts/refreshes this row; two
-- guards in app-creator and votes (Phase 2g) skip container-management
-- side effects for it. See SELF-HOSTING.md.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS self_hosted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_apps_self_hosted
  ON apps (self_hosted) WHERE self_hosted = TRUE;

-- Staging privacy convention. Tables tagged `staging:private` are
-- TRUNCATEd by db-manager.js's cloneDatabase when spawning a staging
-- clone; columns tagged `staging:private` are UPDATE'd to NULL (or a
-- sentinel for NOT NULL columns) so the surrounding row survives.
-- See src/prompts/app-conventions.md for the convention doc.
--
-- RELATED (#616): the prod-debug read-only role (usernode_debug_ro,
-- src/services/debug-access.js) carries its OWN deny lists
-- (DENIED_TABLES / DENIED_COLUMNS). When you add a NEW credential-
-- bearing table or column here (anything you'd tag staging:private
-- because it stores a password, key, or token — not merely private
-- user content), add it to those deny lists too so admin debugging
-- sessions can never SELECT it. tests/prod-debug-access.test.js
-- cross-checks the credential-tagged columns below against the lists.
--
-- RELATED (#1130): there is a SECOND read-only role, the admin SQL
-- console's (topochain_console_ro,
-- src/services/topochain/db-console-scope.js). It denies credential
-- COLUMNS, never whole tables, because a platform admin who cannot read
-- a table here just reads it somewhere less redacted. It IMPORTS
-- DENIED_COLUMNS above (so a new credential column added there covers
-- both roles) and adds CONSOLE_CREDENTIAL_COLUMNS for the columns inside
-- the tables debug-access.js denies wholesale. So a new credential
-- column needs a DENIED_COLUMNS entry; a new credential column on a
-- table that is denied WHOLESALE for prod-debug needs a
-- CONSOLE_CREDENTIAL_COLUMNS entry as well.
-- tests/topochain-db-tools.test.js cross-checks the credential-tagged
-- columns below, and sweeps this file for credential-shaped column
-- names, against the console lists.
--
-- Table-level: every row is sensitive in its entirety.
COMMENT ON TABLE sessions               IS 'staging:private';
COMMENT ON TABLE activation_codes       IS 'staging:private';
COMMENT ON TABLE chat_sessions          IS 'staging:private';
COMMENT ON TABLE chat_session_messages  IS 'staging:private';
COMMENT ON TABLE chat_session_specs     IS 'staging:private';
COMMENT ON TABLE chat_session_spec_user_shares IS 'staging:private';
COMMENT ON TABLE llm_usage              IS 'staging:private';
COMMENT ON TABLE notifications          IS 'staging:private';
COMMENT ON TABLE message_bookmarks      IS 'staging:private';
COMMENT ON TABLE notification_bookmarks IS 'staging:private';
COMMENT ON TABLE app_secrets            IS 'staging:private';
-- `mail_deliveries` is tagged too, but its COMMENT lives beside its
-- CREATE TABLE further down this file — the table doesn't exist yet at
-- this point, and a COMMENT ON a missing table aborts the whole re-apply.

-- Column-level on `users`: rows survive cloning so FK-targeted
-- attribution (chat_messages.user_id, apps.created_by, …) keeps
-- working in staging. Only the auth-sensitive columns get scrubbed.
-- usernode_pubkey is intentionally NOT scrubbed: it's an on-chain
-- public identity, no different from username for privacy purposes,
-- and a self-app dev wants to see it to test wallet-link flows.
COMMENT ON COLUMN users.password               IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_enc      IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_last4    IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_token      IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_expires_at IS 'staging:private';

-- Per-app postgres role passwords. A staging clone has no legitimate
-- need for the prod credentials of any app (including its own — the
-- clone has its own dedicated role with its own ephemeral password),
-- so blank every row's value. Without this scrub, a self-app staging
-- container could SELECT db_password FROM apps and recover every
-- prod app's credential.
COMMENT ON COLUMN apps.db_password IS 'staging:private';

-- Public by omission (no comment): apps, app_activity, issues, the
-- users table itself, chat_messages, issue_votes, pr_votes. These
-- carry no per-row secrets and the aggregates are already visible
-- to anyone the staging clone would be spun up for.

-- PR kudos. A platform-wide appreciation signal that's orthogonal to
-- `pr_votes` (which is a yes/no merge gate). Every user gets a weekly
-- allowance (WEEKLY_KUDOS_LIMIT in src/services/bounties.js, currently
-- 20, shared with issue bounties), can give at most 1 per PR, can't give
-- to their own PR, and can't take a kudos back.
-- Eligibility lives in src/routes/kudos.js:
-- only chat_sessions in status ('promoted','merging','merged') can
-- receive kudos.
--
-- `week_start` is the Monday-00:00-UTC bucket containing `created_at`,
-- stored explicitly so (giver_user_id, week_start) is an indexable
-- equality lookup for the per-week quota check. Postgres
-- `date_trunc('week', x AT TIME ZONE 'UTC')::DATE` returns the Monday
-- of that ISO week, which matches the boundary exactly. See
-- src/routes/kudos.js for both the JS-side (`weekStartUtc`) and SQL
-- usages — keep them aligned if the boundary is ever changed.
--
-- Tagged staging:private so kudos history doesn't leak into staging
-- clones; per-user counts are derivable from production but the
-- row-level (giver, PR) attribution is privacy-flavored social data.
CREATE TABLE IF NOT EXISTS pr_kudos (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  giver_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, giver_user_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_session     ON pr_kudos (session_id);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_giver_week  ON pr_kudos (giver_user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_created     ON pr_kudos (created_at DESC);
COMMENT ON TABLE pr_kudos IS 'staging:private';

-- Issue bounties — a "Give kudos" pledge placed on a GitHub issue from the
-- Open Issues activity-panel section. A bounty is a SYMBOLIC off-chain
-- ledger entry (no tokens, no on-chain transfer): pledging it debits the
-- giver's shared weekly kudos allowance (the same 5/week cap pr_kudos
-- enforces, counted across BOTH tables — see src/routes/kudos.js). When a
-- merged PR closes the issue (via its chat_sessions.linked_issues link),
-- the open bounty flips to 'awarded' and is credited to that PR's author —
-- see src/workflow/rules/bounties.ts (the merge-followups machine).
--
-- Keyed by (app_id, github_issue_number) — NOT the internal `issues` table —
-- because the Open Issues section lists the repo's GitHub issues, which may
-- have no internal proposal row. staging:private for the same reason as
-- pr_kudos: row-level (giver, issue) attribution is privacy-flavored social
-- data. (A private table may FK public tables; only the reverse is barred.)
CREATE TABLE IF NOT EXISTS issue_bounties (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  giver_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  week_start           DATE NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'open',
  awarded_session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  awarded_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One OPEN bounty per (app, issue, giver). A partial unique index keeps the
-- constraint scoped to status='open' so a giver can re-pledge after a prior
-- bounty of theirs has already been awarded/voided.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_bounties_open_uniq
  ON issue_bounties (app_id, github_issue_number, giver_user_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_issue_bounties_issue
  ON issue_bounties (app_id, github_issue_number, status);
CREATE INDEX IF NOT EXISTS idx_issue_bounties_giver_week
  ON issue_bounties (giver_user_id, week_start);
COMMENT ON TABLE issue_bounties IS 'staging:private';

-- Manual "In progress" claims on GitHub issues (the hand-set half of the
-- issue in-progress status; the automatic half derives from
-- chat_sessions.linked_issues at read time — see GET /github-issues in
-- src/routes/issues.js). One row per (app, issue, user): several people
-- can claim the same issue concurrently, each owning exactly one claim.
-- Claims carry no status column and are never swept — expiry is a
-- read-time filter: a claim is live while GREATEST(claimed_at, the
-- issue's discussion-thread last activity) is within ISSUE_CLAIM_TTL_DAYS
-- (7). Renewal (re-POST by the owner) just refreshes claimed_at; clearing
-- deletes the row (claimer or write-admin only). Keyed by GitHub issue
-- number for the same reason as issue_bounties. NOT staging:private —
-- claims are group-visible coordination data (the chip names claimers to
-- everyone), so cloned rows are as public in staging as in prod.
CREATE TABLE IF NOT EXISTS issue_claims (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, github_issue_number, user_id)
);

-- Per-user app favorites. Personal shortcut — starred apps appear in a
-- dedicated section above the main grid on the home screen. No effect
-- on visibility or permissions for other users. Not staging:private
-- because favorites are non-sensitive and useful in staging previews.
CREATE TABLE IF NOT EXISTS app_favorites (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_favorites_user ON app_favorites(user_id);
-- Per-user manual ordering of starred apps (issue #128). NULL = no
-- explicit position: such rows sort after all explicitly ordered ones,
-- falling back to the activity-based list order. Lower = earlier.
-- Uniqueness is deliberately not enforced — gaps/ties are tolerated and
-- resolved by the fallback, and PUT /api/favorites/order rewrites the
-- caller's full set contiguously on every save anyway.
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS sort_order INTEGER;
-- #618: per-user "Your apps" opt-out for member apps. Membership
-- (app_collaborators) pins an app into the home screen's "Your apps"
-- section; a hidden=TRUE row here suppresses that pin for this user
-- only — display preference, zero effect on access or permissions.
-- Row semantics: hidden=FALSE (the default, and every pre-migration
-- row) = a manual add (the classic favorite); hidden=TRUE = an
-- explicit opt-out. The favorite toggle endpoint decides which to
-- write: members get the hidden upsert, non-members get the old
-- insert/delete (see POST /api/apps/:slug/favorite in
-- src/routes/apps.js).
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Free-form per-user home-screen layout: where every app tile and widget
-- sits on the launcher grid, as a real (column, row) CELL rather than a
-- position in a flow. This is what makes holes possible — an arrangement
-- with an empty row and one app alone in the bottom-right corner is
-- expressible here and is not expressible as an ordering.
--
-- ONE LAYOUT PER COLUMN COUNT. `cols` is the breakpoint discriminator: the
-- home grid is 4 columns on a phone and 5 above 640px, and a layout with
-- intentional holes has no round-trip between the two widths. Storing one
-- arrangement per width is what lets a phone drag be remembered without
-- silently rewriting the desktop arrangement (and vice versa). A width with
-- NO rows means "never dragged at this width" — the client derives that
-- view by reflowing the other one (or from app_favorites.sort_order flow
-- order) and only persists once the user actually drags there. That is why
-- this table needs no backfill: every existing account keeps today's
-- arrangement as a derivation.
--
-- A table rather than a JSONB column on `users` (the retired
-- home_panel_positions above was the latter) precisely for the app FK:
-- ON DELETE CASCADE means a deleted app vacates its cell for free, where a
-- blob would accumulate dead ids that every home paint would have to filter.
--
-- Cells only, never sizes: a widget's footprint (w x h, per column count)
-- comes from PANEL_REGISTRY in src/routes/home-panels.js, so a widget can
-- be resized in code without migrating anyone's stored layout. The client's
-- HomeLayout.repair() resolves any overlap that a size change introduces.
--
-- Widget rows are NEVER conditional on the viewer's permissions — notably
-- the 'create' widget is stored for every account regardless of app quota;
-- whether it is tappable is a render-time read of the derived canCreateApps
-- boolean. Nothing about quota reaches this table, so gaining or losing it
-- can never move or drop anyone's tiles.
--
-- Not staging:private: a home-screen arrangement is a display preference
-- with no sensitive content, and staging previews are far more useful with
-- real layouts in them.
CREATE TABLE IF NOT EXISTS user_home_layout (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 4 (phone) or 5 (>= 640px). Kept in step with HomeLayout.columnsForWidth
  -- in frontend/src/features/home/home-layout.js and the grid classes on #app-list.
  cols        SMALLINT NOT NULL,
  item_type   TEXT NOT NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  widget_key  TEXT,
  grid_col    SMALLINT NOT NULL,
  grid_row    SMALLINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_home_layout_kind CHECK (
    (item_type = 'app' AND app_id IS NOT NULL AND widget_key IS NULL)
    OR (item_type = 'widget' AND widget_key IS NOT NULL AND app_id IS NULL)
  ),
  CONSTRAINT user_home_layout_cols CHECK (cols IN (4, 5)),
  CONSTRAINT user_home_layout_col CHECK (grid_col >= 0 AND grid_col < cols),
  -- 8 rows is the free-PLACEMENT canvas, not a capacity cap: items that
  -- don't fit render as dense overflow rows below it (client-side) and are
  -- simply not stored until they're dragged back onto the canvas.
  CONSTRAINT user_home_layout_row CHECK (grid_row >= 0 AND grid_row < 8)
);
-- One cell per item per width. Partial indexes rather than a composite PK
-- because exactly one of app_id / widget_key is set on any row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_home_layout_app
  ON user_home_layout(user_id, cols, app_id) WHERE app_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_home_layout_widget
  ON user_home_layout(user_id, cols, widget_key) WHERE widget_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_home_layout_read
  ON user_home_layout(user_id, cols);

-- Admin-curated "Find more apps" row on the home screen. Global (one
-- ordered list for everyone — no per-user targeting), display-only, and
-- zero effect on access: the row is derived client-side from the
-- `featured` / `featured_order` flags GET /api/apps already serializes
-- per viewer, so a featured VIEW-PRIVATE app is simply absent for
-- someone who can't see it — the visibility filter in that query is the
-- only gate needed.
--
-- A table rather than a platform_settings blob so app deletion cascades
-- and the admin console can join names/icons directly.
-- Deliberately NOT staging:private: curation is public information (the
-- row is on every user's home screen). Rows don't exist in prod yet, so
-- a staging clone starts empty — src/db/migrate.js seeds a few under
-- IS_STAGING so PR previews can review the row at all.
-- Written only by PUT /api/admin/featured-apps (full-rewrite, admin
-- only); read by the LEFT JOIN in GET /api/apps.
CREATE TABLE IF NOT EXISTS featured_apps (
  app_id      INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_featured_apps_order ON featured_apps(sort_order);

-- Append-only product-analytics event log. The long-term source of truth
-- behind the admin /dashboard (growth, retention, and the dapp-usage /
-- PR-promotion funnels). Rows are written fire-and-forget at action sites
-- via src/services/events.js (never blocking or failing the originating
-- request). On first boot the events table is backfilled from the existing
-- domain tables (users, apps, app_activity, chat_messages, pr_votes,
-- pr_kudos, app_favorites, chat_sessions) so the funnels and retention
-- curves are continuous across the cutover — see backfillEvents() in
-- src/db/migrate.js.
--
-- `event_type` is a free-form verb (e.g. 'user_signed_up', 'dapp_opened',
-- 'pr_promoted', 'pr_merged'); see EVENT_TYPES in src/services/events.js
-- for the canonical list. The nullable user/app/session FKs use ON DELETE
-- SET NULL so analytics history survives the deletion of the referenced
-- row (the aggregate counts stay correct even after a user is removed).
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  event_type  VARCHAR(64) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at);

-- #717: restart/recovery-safe receipt for provider-neutral invocation rows.
-- Ordinary product analytics events do not carry invocation_key and are
-- unaffected. The key is an opaque platform id, never provider/user content.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_llm_invocation_key
  ON events ((metadata->>'invocation_key'))
  WHERE event_type = 'llm_invocation' AND metadata ? 'invocation_key';

-- A navigation keeps one browser-generated UUID through offline / transport
-- retries. Scope it to its authenticated viewer and app: the same opaque UUID
-- from another account is unrelated, while an exact replay is one opening.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dapp_opening_key
  ON events (user_id, app_id, (metadata->>'openingId'))
  WHERE event_type = 'dapp_opened' AND metadata ? 'openingId';

-- UI telemetry is uploaded in retryable batches. Both ids are opaque random
-- client values validated by services/ui-telemetry.js; these indexes make a
-- lost response safe to replay without double-counting either observations
-- or delivery receipts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ui_experience_event_id
  ON events (user_id, (metadata->>'eventId'))
  WHERE event_type = 'ui_experience' AND metadata ? 'eventId';
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ui_delivery_batch_id
  ON events (user_id, (metadata->>'batchId'))
  WHERE event_type = 'ui_telemetry_delivery' AND metadata ? 'batchId';

-- The admin Journey's creation path (services/journey-events.js): a
-- preview counts as opened once per viewer per change, however often it is
-- reopened, and a merged change is recorded live once, however often its
-- merge's tail runs again after a restart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_preview_opened_once
  ON events (session_id, user_id)
  WHERE event_type = 'preview_opened';
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_change_live_once
  ON events (session_id)
  WHERE event_type = 'change_live';
-- The admin Journey's first session (services/journey-events.js): a
-- project's sketch is its maker's first artefact once, however often the
-- made screen frames it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_first_artefact_once
  ON events (app_id)
  WHERE event_type = 'first_artefact_shown';
-- Its invite funnel (#4176): signing in through an invite link is recorded
-- once per person per link, however often they sign in carrying it or
-- open it signed in.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_invite_signed_in_once
  ON events (user_id, (metadata->>'inviteId'))
  WHERE event_type = 'invite_signed_in';
-- A project's app seen down (services/app-outages.js): one row per app per
-- minute, for the unavailable page shown to somebody opening it
-- ('app_unavailable') and for the watchdog starting it again
-- ('app_restarted', metadata.count times in that minute). The Infra
-- topic's figures read them (services/topic-figures.js).
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_app_down_minute
  ON events (app_id, event_type, (metadata->>'minute'))
  WHERE event_type IN ('app_unavailable', 'app_restarted') AND metadata ? 'minute';
-- When those rows began: an open from before it had no way to be seen
-- failing, so "App opens that worked" counts only the opens since.
INSERT INTO platform_settings (key, value) VALUES
  ('app_outages_tracked_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- Tagged staging:private so the analytics log (which is derived from
-- chat_sessions / pr_kudos, both already private) is TRUNCATEd in staging
-- clones rather than leaking social history into previews.
COMMENT ON TABLE events IS 'staging:private';

-- Per-app visibility (collaborator & viewer privacy).
--   collab_visibility: who may participate in building the app (group
--     chat, dev sessions, voting, issues, kudos). 'public' = everyone.
--   view_visibility:   who may see the app exists and use it (home list,
--     App tab). 'public' = everyone.
-- Invariants (enforced by the CHECK below + API validation in
-- routes/apps.js): collab-public implies view-public, and view-private
-- means the viewer list IS the collaborator list (viewers are never
-- separately enumerated). Admins always see everything — enforced in
-- src/services/app-access.js, the shared gate every route goes through.
-- Post-creation changes go through dapp.json's top-level `visibility`
-- block (issue #124): a vote-gated PR edits the block and the merge's
-- production rebuild reconciles these columns to it
-- (services/app-manifest.js reconcileAppVisibility).
-- Defaults make every pre-migration app public/public (no behavior change).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS collab_visibility VARCHAR(10) NOT NULL DEFAULT 'public';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS view_visibility   VARCHAR(10) NOT NULL DEFAULT 'public';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'apps_visibility_combo_check' AND conrelid = 'apps'::regclass
  ) THEN
    ALTER TABLE apps ADD CONSTRAINT apps_visibility_combo_check
      CHECK (NOT (collab_visibility = 'public' AND view_visibility = 'private'));
  END IF;
END $$;

-- Anonymous-shell probe result (landing-page app directory).
--   anon_shell: whether the app's shell and conventional API gate permit
--     anonymous access. 'public' = GET / succeeds and GET /api/ succeeds
--     or has no route (404, e.g. a static app). 'gated' = either requires
--     authentication, 'unknown' = never probed or unclassifiable.
--     Written ONLY by services/shell-probe.js; consumed by
--     GET /api/public/apps as `requires_login` (anything not 'public').
--     'unknown' renders as account-required — the safe default, matching
--     the scaffold's gated-by-default behavior.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS anon_shell VARCHAR(10) NOT NULL DEFAULT 'unknown';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS anon_shell_checked_at TIMESTAMPTZ;

-- Per-app proposal-approval governance (issue #646).
--   approver_policy:    who can approve proposals. 'anyone' = every
--     eligible voter's vote counts toward the merge gate (today's
--     behavior); 'invited' = only votes from app_approvers members
--     count — everyone else's votes are advisory.
--   approvals_required: how many approvals are needed. NULL = the
--     default time-&-majority strategy (services/active-users.js
--     mergeGate); >= 1 = "at least N" mode — a proposal merges as soon
--     as it has N qualifying yes votes, with no visibility window,
--     lazy-consensus clock, contested state, or auto-rejection.
-- Source of truth is dapp.json's top-level `governance` block,
-- reconciled on every production deploy (services/app-manifest.js
-- reconcileAppGovernance) and — unlike visibility — also at boot for
-- the self-hosted platform app (db/migrate.js seedSelfApp). Defaults
-- make every pre-migration app behave exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approver_policy VARCHAR(10) NOT NULL DEFAULT 'anyone';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approvals_required SMALLINT;

-- Who says yes (#4666): the approval rule a project chose by name (a preset)
-- or built from groups and rules of its own, from dapp.json's `governance`
-- block (`preset`, or `groups` + `rules`; services/governance-rules.js).
-- `{ preset, groups: [{ name, people, ids }], rules: [{ group, kind, n }] }`,
-- with each named group's people resolved to user ids at reconcile. NULL is
-- every project that never chose one: approver_policy and
-- approvals_required above decide, exactly as before. Reconciled with them
-- (services/app-manifest.js reconcileAppGovernance); a block with rules
-- puts those two back to their defaults.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS governance_rules JSONB;

-- Per-app admins (#788), display side. The last reconciled *declared*
-- username list from dapp.json's top-level `admins` block — INCLUDING
-- names that resolved to no registered user, which is exactly why this
-- exists alongside the resolved-id table `app_admins` below: the
-- Members panel can say "@carol — declared, not a registered user"
-- without a second source. Never consulted for permission checks (the
-- `app_admins` rows are the authority); purely for display and to keep
-- the settings endpoint a single query. Defaults to the empty array so
-- every pre-migration app reads as "no declared admins".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS admin_usernames TEXT[] NOT NULL DEFAULT '{}';

-- Pixel density the platform captures this app's before/after preview
-- screenshots at (issue #360). 2 = HiDPI/retina (the default, matching
-- real laptops/phones — surfaces "only broken on retina" bugs as a
-- visible before/after diff); 1 = standard density, opted into by apps
-- that genuinely need it (pixel art). Source of truth is dapp.json's
-- top-level `screenshot.deviceScaleFactor`, reconciled here on every
-- deploy (services/app-manifest.js reconcileAppScreenshot) and read by
-- the capture orchestrator (services/visuals.js captureForSession).
-- DEFAULT 2 means every pre-migration app captures at 2× with no
-- manifest edit.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS screenshot_device_scale SMALLINT NOT NULL DEFAULT 2;

-- Homescreen icon, source of truth: dapp.json's optional top-level
-- `icon` block ({"emoji": "🎮"} or {"image": "public/icon.png"}),
-- reconciled on every deploy (services/app-manifest.js
-- reconcileAppIcon). Both NULL = the letter-tile fallback the home
-- card always rendered. icon_image_id points at an app_icons row and
-- deliberately carries no FK: the reconcile owns both sides' lifecycle
-- and rotates the id only when the committed bytes change (the
-- /app-icons/:id cache header is immutable, so a new id doubles as
-- the cache-buster).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS featured_illustration JSONB;
CREATE TABLE IF NOT EXISTS app_illustrations (
  app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  id VARCHAR(32) NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL
);

ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS dark_id VARCHAR(32) UNIQUE;
ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS dark_content_type TEXT;
ALTER TABLE app_illustrations ADD COLUMN IF NOT EXISTS dark_data BYTEA;

-- #2086: a featured-illustration change is a governance proposal now, not a
-- direct write. The bytes a proposal carries wait here, keyed by the issue
-- row that is the proposal, until the group votes it in (at which point the
-- apply copies them into app_illustrations under the SAME ids, so the card's
-- preview URL keeps resolving) or the proposal settles without applying. One
-- open illustration proposal per app, enforced by the partial index below
-- rather than by a read-then-insert the two saves in a race would both pass.
CREATE TABLE IF NOT EXISTS app_illustration_proposals (
  issue_id INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  id VARCHAR(32) UNIQUE,
  content_type TEXT,
  data BYTEA,
  dark_id VARCHAR(32) UNIQUE,
  dark_content_type TEXT,
  dark_data BYTEA
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_open_featured_illustration
  ON issues (app_id)
  WHERE kind = 'featured_illustration' AND status = 'open';

ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_emoji VARCHAR(32);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_image_id VARCHAR(32);
-- A project's colour, when its dapp.json sets one beside its icon
-- ("icon": { "color": "#2e6660" }). NULL means the page derives one from the
-- icon in the browser (frontend/src/lib/community-color.ts).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_color VARCHAR(7);

-- #1523: an admin's directory review, independent of container health and
-- of the staging-only `demo` fixture flag. Existing apps remain unreviewed.
-- A positive review is valid only for its deployed SHA and until the next
-- deployment; demos/broken classifications persist until explicitly reviewed.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS directory_review_status VARCHAR(16)
  NOT NULL DEFAULT 'unreviewed' CHECK (directory_review_status IN ('unreviewed', 'working', 'demo', 'broken'));
ALTER TABLE apps ADD COLUMN IF NOT EXISTS directory_reviewed_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS directory_reviewed_sha VARCHAR(40);

-- Fork lineage. NULL for normally-created apps; for a fork it stores a
-- REFERENCE ONLY to the source app: {"appId": <id>, "slug": "<slug>"}.
-- The source's display name is deliberately NOT persisted here — it is
-- resolved LIVE at serialize time (routes/apps.js) by looking the source
-- up by appId, so a rename on the original is reflected immediately and
-- a deleted source resolves to the literal "<deleted>" (link inert).
-- A plain JSONB reference (not an FK) is used on purpose: an FK with
-- ON DELETE would blank the reference exactly when we still want to show
-- "forked from <deleted>". NOT staging:private — lineage renders on the
-- public home feed and must survive into staging clones.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS forked_from JSONB;

-- Icon image bytes, one row per app, keyed by an unguessable random id
-- (same access stance as session_visuals: /app-icons/:id is served
-- unauthenticated so home tiles load it with a plain <img>, and the
-- 32-hex id is the only access control — an icon discloses only
-- itself). Bytes live OFF the apps row on purpose: GET /api/apps
-- spreads SELECT a.* into JSON, and a BYTEA column there would
-- serialize into every list response. NOT staging:private — icons
-- render on the public home feed and should survive into staging
-- clones.
CREATE TABLE IF NOT EXISTS app_icons (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER UNIQUE NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  content_type VARCHAR(32) NOT NULL,
  data         BYTEA       NOT NULL,
  sha256       VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- App membership + invites in one table. A row with status='invited' is
-- a pending invite (grants NO access — every check requires 'member');
-- declining deletes the row so re-invites work. The creator gets a
-- member row at creation time (and via the backfill below for existing
-- apps), so "creator is always a collaborator" holds uniformly.
-- Deliberately NOT staging:private (like app_favorites): membership must
-- survive into staging clones so a cloned platform's own access checks
-- keep working, and rows carry no secrets.
CREATE TABLE IF NOT EXISTS app_collaborators (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_collaborators_user ON app_collaborators(user_id, status);

-- Invites into a project by EMAIL, for somebody who may not be on Homeroom
-- yet (the create dialog's "Will invite" rows; services/email-invites.js).
-- An address that already belongs to a confirmed account is invited as that
-- account instead, straight into app_collaborators, and never lands here, so
-- the creator's screen cannot tell who has an account. A row here waits
-- for its address to be confirmed on an account (email sign-up, or adding
-- it in Settings), which turns it into an ordinary pending collaborator
-- invite and stamps claimed_at. The invited person joins the waitlist like
-- anyone else; this grants no platform access.
CREATE TABLE IF NOT EXISTS app_email_invites (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,          -- lowercased
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at  TIMESTAMPTZ,
  claimed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (app_id, email)
);
CREATE INDEX IF NOT EXISTS idx_app_email_invites_pending
  ON app_email_invites (email) WHERE claimed_at IS NULL;
-- Addresses people typed: personal data, not copied into staging.
COMMENT ON TABLE app_email_invites IS 'staging:private';

-- Backfill: every existing app's creator becomes a member. Idempotent.
INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
  SELECT id, created_by, 'member', NOW() FROM apps WHERE created_by IS NOT NULL
ON CONFLICT (app_id, user_id) DO NOTHING;

-- Proposal approvers + invites (issue #646), a structural clone of
-- app_collaborators: one table holds both approver members
-- (status='member') and pending invites (status='invited'). A pending
-- invite grants NOTHING — the merge-gate math counts only 'member'
-- rows; declining/revoking deletes the row so re-invites work. Only
-- consulted when apps.approver_policy = 'invited'; rows are kept
-- dormant when the policy flips back to 'anyone'. Deliberately NOT
-- staging:private (like app_collaborators): the roster carries no
-- secrets and must survive into staging clones so the governed-gate
-- math stays testable there. No creator backfill — approvers are
-- opt-in (the reconcile auto-seeds the creator only at the moment an
-- app first switches to 'invited' with an empty roster).
CREATE TABLE IF NOT EXISTS app_approvers (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_approvers_user ON app_approvers(user_id, status);

-- Per-app admins (#788), authority side. A structurally slimmer
-- app_approvers: deliberately NO status/invite columns, because the
-- manifest PR IS the consent mechanism — an admins change is voted in
-- and merged before it ever reaches this table, so there is nothing
-- left to accept. Source of truth is dapp.json's top-level `admins`
-- block, reconciled on every production deploy
-- (services/app-manifest.js reconcileAppAdmins), which makes these rows
-- match the declared list exactly (an explicit empty array clears the
-- roster; an ABSENT block is a no-op). Self-hosted apps are skipped —
-- the platform repo can never mint app admins.
-- An app admin is treated as a second app creator for that ONE app
-- (see services/app-admins.js canManageApp) and may force-merge that
-- app's proposals — except ones flagged requires_explicit_approval,
-- which would be self-escalation.
-- Deliberately NOT staging:private (like app_collaborators /
-- app_approvers): the roster carries no secrets and must survive into
-- staging clones so the access checks keep behaving there.
CREATE TABLE IF NOT EXISTS app_admins (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_admins_user ON app_admins(user_id);

-- Before/after visuals on UI-affecting proposals (issue #195). Each row is
-- one capture artifact produced by the one-shot usernode-capture container
-- after a staging preview comes up healthy: kind = before (production) /
-- after (staging), media = png (still) / webm (in-app <video> clip) /
-- gif (PR-body inline embed). Retention is latest-set-per-session only —
-- src/services/visuals.js deletes the session's prior rows before
-- inserting a fresh capture, so growth is bounded per session (<= 8
-- artifacts per captured path — a full-media desktop group plus a
-- PNG-only mobile group — times CAPTURE_MAX_PATHS routes).
-- The id is a random 32-hex token generated in Node: GET /visuals/:id is
-- a public (pre-auth) route so GitHub's camo proxy can fetch embeds
-- anonymously, and unguessable ids are the only privacy layer.
-- Artifacts are bytea-in-Postgres because the platform container has no
-- persistent file volume; the serving route isolates that storage choice.
CREATE TABLE IF NOT EXISTS session_visuals (
  id            VARCHAR(32) PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  commit_hash   VARCHAR(64),
  kind          VARCHAR(8)  NOT NULL,
  media         VARCHAR(8)  NOT NULL,
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA       NOT NULL,
  captured_path VARCHAR(512),
  -- #270: capture order within a session. A proposal can now point its
  -- screenshots at a short ordered list of routes; each route is a
  -- "capture group" sharing one capture_index, and the renderers emit one
  -- labelled before/after row per group. Defaults to 0 so pre-#270 rows
  -- form a single legacy group with no migration backfill needed.
  capture_index SMALLINT NOT NULL DEFAULT 0,
  -- #768: viewport label the group was shot at ('mobile' for a testing
  -- path annotated `@mobile`; NULL = the default desktop frame). Renderers
  -- suffix labelled groups with "(mobile)" so reviewers know what frame
  -- they're looking at. NULL on pre-#768 rows — desktop by definition.
  captured_viewport VARCHAR(16),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS capture_index SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS captured_viewport VARCHAR(16);
-- Capture-outcome columns (screenshot-reliability spec):
--   shot_status      : HTTP status the shot's navigation answered with
--                      (NULL on pre-outcome rows).
--   before_fell_back : TRUE when this "before" artifact was actually shot
--                      at '/' because the deep testing path 404'd / failed
--                      on production (the page didn't exist there yet).
--                      Renderers caption the pair so reviewers aren't
--                      confused by a mismatched comparison.
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS shot_status SMALLINT;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS before_fell_back BOOLEAN NOT NULL DEFAULT FALSE;
-- Named executable scenario provenance (#1906). NULL means the capture came
-- from an explicit submission route or predates visual scenarios. The stable
-- id says which dapp.json flow was selected; the fingerprint pins the route +
-- readiness assertions at capture time, so a later edit cannot silently make
-- an old image look like evidence for a different scenario definition.
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS scenario_id VARCHAR(96);
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS scenario_fingerprint VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_session_visuals_session ON session_visuals(session_id);

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids); the artifacts also embed
-- screenshots of other users' staging previews.
COMMENT ON TABLE session_visuals IS 'staging:private';

-- Snapshot of the rendered "Before / after" PR-body block last written to
-- GitHub, mirroring pr_testing_applied: applyPrMetadata compares the fresh
-- block against this to decide whether a title-unchanged turn still needs
-- a PR body update, and src/services/visuals.js stamps it after its
-- targeted post-capture body patch so the next turn doesn't rewrite an
-- unchanged body.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_visuals_applied TEXT;

-- Plain-language, user-facing summary of a proposed change (1-3 sentences,
-- no jargon/file names/code). Generated alongside pr_title by the
-- PR-metadata call (Sonnet 5.5, llm.PR_METADATA_MODEL), prepended as the first paragraph of the GitHub PR body,
-- and rendered at the top of the in-app proposal view (the column is this
-- surface's single source of truth). NULL = none generated yet (legacy /
-- pre-feature proposals, or an LLM-unavailable fallback); the view simply
-- omits the summary paragraph in that case.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_md TEXT;

-- A summary is a snapshot of proposal inputs, not a timeless description.
-- Keep the last copy visible when inputs change and track its freshness
-- separately. Generated writes may publish only against the input version
-- they read before generation.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_source TEXT
  CHECK (pr_summary_source IN ('author', 'generated'));
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_source_head_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_source_body_hash VARCHAR(64);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_input_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_applied_version BIGINT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_previous_md TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_stale BOOLEAN NOT NULL DEFAULT FALSE;
-- Existing summaries have no recorded input revision. Preserve their words,
-- but do not assert that they describe today's branch or description.
UPDATE chat_sessions
   SET pr_summary_source = CASE WHEN source = 'imported' THEN 'author' ELSE 'generated' END,
       pr_summary_previous_md = pr_summary_md,
       pr_summary_stale = TRUE
 WHERE pr_summary_md IS NOT NULL AND pr_summary_source IS NULL;
-- The previous freshness migration archived live summaries. Restore them
-- without claiming they describe the current revision. Normal invalidation
-- no longer clears this column, so this remains safe on repeated startup.
UPDATE chat_sessions
   SET pr_summary_md = pr_summary_previous_md,
       pr_summary_stale = TRUE
 WHERE pr_summary_md IS NULL AND pr_summary_previous_md IS NOT NULL;

-- History is an input to generated PR metadata. Invalidate in the same
-- transaction as a new request or native handoff summary, including context
-- that arrives after the PR was first written. Hosted turn summaries are
-- saved after PR generation; that generation already receives the in-flight
-- text, so saving the same text must not invalidate its new summary.
CREATE OR REPLACE FUNCTION invalidate_pr_summary_on_history() RETURNS TRIGGER AS $$
DECLARE relevant BOOLEAN := FALSE;
BEGIN
  IF NEW.session_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    relevant := NEW.role = 'user' OR NEW.metadata->>'handoffSummary' = 'true';
  ELSE
    relevant := (NEW.role = 'user' AND NEW.content IS DISTINCT FROM OLD.content)
      OR NEW.metadata->>'handoffSummary' IS DISTINCT FROM OLD.metadata->>'handoffSummary';
  END IF;
  IF relevant THEN
    UPDATE chat_sessions
       SET pr_summary_input_version = pr_summary_input_version + 1,
           pr_summary_previous_md = COALESCE(pr_summary_md, pr_summary_previous_md),
           pr_summary_stale = pr_summary_stale OR pr_summary_md IS NOT NULL
     WHERE id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pr_summary_history ON chat_session_messages;
CREATE TRIGGER trg_pr_summary_history
  AFTER INSERT OR UPDATE OF content, metadata ON chat_session_messages
  FOR EACH ROW EXECUTE FUNCTION invalidate_pr_summary_on_history();

-- App access to user LLM budgets (issue #34). One row per (app, user)
-- consent: the user explicitly allowed this app to spend from their
-- daily AI budget through the platform proxy (/api/app-llm), up to
-- daily_cap_cents per day. Revocation keeps the row (usage history,
-- easy re-grant) and just flips status; the proxy requires
-- status='active'. allow_byok extends the grant onto the user's own
-- stored Anthropic key once the platform allowance is exhausted —
-- strictly opt-in per app, still bounded by the cap.
CREATE TABLE IF NOT EXISTS app_llm_grants (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  daily_cap_cents INTEGER NOT NULL DEFAULT 100,
  allow_byok      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_llm_grants_user ON app_llm_grants(user_id);
-- Consent/financial-adjacent rows must not leak into staging clones.
-- (A private table may FK public tables; only the reverse is barred.)
COMMENT ON TABLE app_llm_grants IS 'staging:private';

-- Per-user, per-app grants for the gated browser capabilities (#2219):
-- geolocation, microphone, camera, display-capture, usb, serial, hid,
-- bluetooth and midi. The catalogue is services/app-permissions.js.
--
-- One row per capability rather than a column each, so adding the tenth
-- capability is a catalogue edit and not a migration. `capability` holds a
-- Permissions Policy token and is validated against the catalogue on the
-- way in AND on the way out, which is what lets a capability be retired
-- from the catalogue without orphan rows re-delegating it.
--
-- Revoking keeps the row, exactly as app_llm_grants does: it preserves
-- "this was asked for once" and makes re-granting an upsert. status is the
-- only thing the delegation reads.
CREATE TABLE IF NOT EXISTS app_permission_grants (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability  VARCHAR(32) NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_app_permission_grants_user ON app_permission_grants(user_id);
-- Consent records naming what a person let an app watch, hear or reach.
-- Never cloned into staging: a preview must start with nothing granted,
-- which is also what makes the prompt itself exercisable there.
COMMENT ON TABLE app_permission_grants IS 'staging:private';

-- Per-app daily spend ledger, mirroring llm_usage's split: total goes
-- against the platform daily caps, byok is the display-only bucket for
-- spend billed to the user's own key. The proxy writes BOTH this table
-- and llm_usage (via limits.recordSpend) so platform-wide caps and the
-- existing /api/budget display stay correct.
CREATE TABLE IF NOT EXISTS app_llm_usage (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  byok_cost_cents  NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(app_id, user_id, date)
);
-- Sibling of llm_usage, which is already staging:private.
COMMENT ON TABLE app_llm_usage IS 'staging:private';

-- Per-app credential identifying the calling app to the LLM proxy.
-- Random 64-hex, generated lazily at production deploy when NULL (same
-- adoption shape as db_password). Deliberately NOT a JWT: every dapp
-- container holds the shared JWT_SECRET, so a JWT-based app identity
-- would be forgeable by any other app; a random opaque token is not.
-- staging:private so the column-scrub in cloneDatabase blanks it —
-- staging containers never receive the token and therefore can't
-- spend grants (unreviewed PR code).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS llm_proxy_token TEXT;
COMMENT ON COLUMN apps.llm_proxy_token IS 'staging:private';

-- #249: meaningful default session names. session_title is the
-- display-name layer for dev sessions: set from the first interactive
-- message (Haiku), refreshed at pre-PR turn ends, mirrored from
-- pr_title once a PR exists, and derived deterministically
-- ("#N · issue title") for headless auto sessions. NULL falls back to
-- pr_title then branch_name at every display site. Branch names stay
-- machine-generated and immutable — this column never affects git.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS session_title VARCHAR(256);

-- Experimental AI progress estimate accuracy dataset (#50 follow-up).
-- Each row records one estimator tick: what the small model predicted
-- (remaining-time number + hedged phrase) and how far into the run it
-- was. When the turn ends, the actual outcome is backfilled (whole-turn
-- wall clock, per-tick ground-truth remaining, and how the turn ended)
-- so estimator accuracy can be evaluated later. Anchored on the per-turn
-- progress-log message (progress_message_id) — the codebase has no
-- first-class "turn" row, and a fresh progress message is created per
-- build turn, which uniquely identifies it. Invisible in the product for
-- now; reviewing accuracy is deferred follow-up work.
CREATE TABLE IF NOT EXISTS progress_estimates (
  id                          BIGSERIAL PRIMARY KEY,
  session_id                  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  progress_message_id         INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  model                       VARCHAR(64),
  -- Inputs at estimate time.
  elapsed_ms                  INTEGER NOT NULL,
  step_count                  INTEGER NOT NULL DEFAULT 0,
  progress_lines              INTEGER NOT NULL DEFAULT 0,
  -- Prediction.
  estimate_text               VARCHAR(120),
  predicted_remaining_seconds INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Later-filled actuals (NULL until the turn reaches a terminal point).
  actual_total_ms             INTEGER,
  actual_remaining_ms         INTEGER,
  outcome                     VARCHAR(16),
  resolved_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_message ON progress_estimates(progress_message_id);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_session ON progress_estimates(session_id, created_at);
-- staging:private — forced, not a preference: this table FKs both
-- chat_sessions and chat_session_messages, which are already
-- staging:private, and the migration linter forbids a public table
-- FK-ing a private one. The rows are also per-user run-timing data with
-- no value in a staging clone, so it ships schema-only + empty there.
COMMENT ON TABLE progress_estimates IS 'staging:private';

-- #892 recalibration columns. The v1 estimator's numeric guess failed every
-- graduation bar (median error 181s vs a 90s bar, 31% within half-to-double
-- vs 60%, -110s bias vs +/-60s), but the failure was a SCALE error inherited
-- from its own prompt, not an absence of signal — within an elapsed bucket
-- its ranking correlated 0.40-0.56 with the truth. v2 feeds the measured
-- run-length distribution in as prompt INPUT (llm.js RUN_LENGTH_PRIORS) and
-- adds a display-side monotonicity guard. These columns are what make the
-- before/after judgeable and the guard auditable.
--
-- `prompt_version` is the important one: without it v1 and v2 pool into a
-- single average that hides whether the change worked. Existing rows are v1
-- by definition, hence the DEFAULT 1.
--
-- `predicted_remaining_seconds` remains the RAW model output in every path
-- (clamped, floored and suppressed alike) — the accuracy metrics score the
-- model, never the guard. `displayed_remaining_seconds` is the post-guard,
-- post-floor value the user actually saw; on v2 rows it is always positive
-- (a fixed 30s floor, so the countdown can never stick at zero). The share
-- of ticks where that floor bound is derived as
-- `displayed_remaining_seconds <= 30` rather than stored separately.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS prompt_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS displayed_remaining_seconds INTEGER;
-- Guard telemetry. `clamped` = the guard held the previous projection
-- because an extension had no cause. `slip_reason` names the cause when one
-- WAS accepted: 'expired' (the projection ran out and the run continues),
-- 'new_phase' (a new stage marker landed), 'revision' (the model at least
-- doubled its own previous guess). NULL when no extension happened.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS clamped BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS slip_reason VARCHAR(24);
-- Completion-claim suppression telemetry. `estimate_text` keeps the
-- UNMODIFIED model phrase (so the dataset still measures the model);
-- `estimate_text_shown` is what was actually rendered, and `suppressed`
-- marks the ticks where a "nearly done" claim was replaced because the run
-- had not yet reached a commit/push/done marker.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS estimate_text_shown VARCHAR(120);
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS suppressed BOOLEAN NOT NULL DEFAULT FALSE;
-- The two new prompt inputs, recorded so a future offline analysis has them
-- without re-deriving from chat_session_messages.metadata->'progressLog'.
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS last_phase VARCHAR(24);
ALTER TABLE progress_estimates ADD COLUMN IF NOT EXISTS distinct_files INTEGER;
-- Outcome vocabulary: 'committed' | 'noop' | 'stopped' | 'error' set by the
-- live backfill at the turn's choke point, plus 'unknown' set by the
-- estimate-backfill sweeper for rows orphaned by a server restart mid-run
-- (services/estimate-backfill.js).

-- #297: per-user, read-only "Ask AI" advisor conversations scoped to a
-- single proposal — the "Mayor in advisor mode" surface. Each row is one
-- turn the conversation OWNER (user_id) sent or the advisor replied with,
-- keyed to either a promoted/merging/merged PR (proposal_kind='pr',
-- proposal_ref=chat_sessions.id) or a governance issue
-- (proposal_kind='gov', proposal_ref=issues.id). proposal_ref is a
-- polymorphic reference with no FK — same precedent as chat_messages
-- thread_ref (a PR session id and a governance issue id can't share one
-- FK target). The conversation is private scratch data: never posted into
-- the shared group thread, and never copied into staging clones
-- (staging:private), so a prod-cloned staging DB ships this table empty
-- and seeds its own "Staging demo …" rows. A private table may FK public
-- tables (apps, users); only the reverse is barred by the linter.
-- RETIRED by #827: the "Ask AI" advisor panel was replaced by the
-- "Explore in dev chat" flow, so nothing reads or writes this table any
-- more. The DDL stays (migrations are append-only; dropping is a separate,
-- deliberate data-retirement change) and existing rows are left in place.
CREATE TABLE IF NOT EXISTS proposal_ai_messages (
  id            SERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  proposal_kind VARCHAR(8) NOT NULL,
  proposal_ref  INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(16) NOT NULL,
  content       TEXT NOT NULL,
  model         VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-conversation, per-user history load: WHERE app_id + kind + ref +
-- user_id, ORDER BY id. The composite index makes that an index range scan.
CREATE INDEX IF NOT EXISTS idx_proposal_ai_messages_convo
  ON proposal_ai_messages (app_id, proposal_kind, proposal_ref, user_id, id);
COMMENT ON TABLE proposal_ai_messages IS 'staging:private';

-- Admin /debug merge & conflict-resolution logs. Each merge attempt (or
-- automatic conflict-resolution attempt) is a "run"; every step inside it
-- (gate check, GitHub merge call, worker sync phase, outcome) is a child
-- row ordered by `seq`. Written fire-and-forget by services/merge-debug.js
-- and read only by the admin-gated /api/debug/* endpoints.
CREATE TABLE IF NOT EXISTS merge_debug_runs (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  pr_number   INTEGER,
  -- 'merge' | 'conflict_resolution' | 'checks'
  --
  -- 'checks' reuses this tracer for the proposal-checks pipeline
  -- (services/visuals.js captureForSession) rather than a merge attempt: one
  -- run per checks run, with a step per phase (image_build, clone,
  -- staging_health, capture, tests) carrying detail.durationMs. Added because
  -- nothing persisted how long a checks run took, so a ~8x slowdown in it
  -- could only be diagnosed from a container log tail before rotation.
  kind        VARCHAR(32) NOT NULL DEFAULT 'merge',
  -- 'vote' | 'force' | 'post_merge_sweep' | 'drift' | 'behind_main' | 'merge_conflict'
  --   | 'capture' (kind='checks')
  trigger     VARCHAR(48),
  -- running | merged | blocked | conflict_resolving | conflict_failed
  --   | awaiting_github | noop | error | pr_closed
  -- A kind='checks' run instead ends on its suite's verdict — passing |
  -- failing | skipped | error — mirroring chat_sessions.check_state.
  status      VARCHAR(32) NOT NULL DEFAULT 'running',
  summary     TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_app     ON merge_debug_runs (app_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_session ON merge_debug_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_started ON merge_debug_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS merge_debug_steps (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES merge_debug_runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  phase      VARCHAR(48),
  -- info | warn | error
  level      VARCHAR(8) NOT NULL DEFAULT 'info',
  message    TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_steps_run ON merge_debug_steps (run_id, seq);

-- staging:private — these rows carry internal session ids, conflict file
-- paths, error text and resolution details that mirror private build
-- history; they're TRUNCATEd in staging clones rather than leaking into
-- previews (same policy as the events / proposal_ai_messages tables). The
-- /debug view seeds its own mock runs under IS_STAGING + ?demo=1.
COMMENT ON TABLE merge_debug_runs  IS 'staging:private';
COMMENT ON TABLE merge_debug_steps IS 'staging:private';

-- #460: per-user global agent instruction & skill files. Uploaded in the
-- account Settings modal ("Agent instructions & skills") and materialized
-- into the per-session CC volume (~/.claude/CLAUDE.md + ~/.claude/skills/)
-- at every build/scout dispatch the user owns — see
-- services/user-agent-files.js + worker.syncUserAgentFiles. Contents are
-- plain user-authored text (NOT secrets — no encryption), but they are
-- personal scratch config with no value in a staging clone, so the table
-- ships schema-only + empty there (staging:private); the Settings section
-- uses ?demo=1 fabricated rows for staging previews instead.
CREATE TABLE IF NOT EXISTS user_agent_files (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'instruction' | 'skill'
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('instruction', 'skill')),
  -- normalized slug: ^[a-z0-9][a-z0-9-]{0,63}$
  name        VARCHAR(64) NOT NULL,
  description VARCHAR(200) NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_user_agent_files_user ON user_agent_files (user_id, kind, name);
COMMENT ON TABLE user_agent_files IS 'staging:private';

-- Dev-chat file attachments (#450). Users attach files to dev-chat
-- messages as extra context for the Mayor, scout, and coding agent.
-- Bytea-in-Postgres like session_visuals (the platform container
-- has no persistent file volume); ids are random 32-hex tokens generated
-- in Node. message_id is NULL between upload and send — the chat handler
-- links it when the message posts, and server.js's session sweeper GCs
-- orphans older than 24h. Retention otherwise follows the parent session
-- (ON DELETE CASCADE), bounded by a 50 MB per-session cap at upload time.
CREATE TABLE IF NOT EXISTS chat_session_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'text' (UTF-8,
  -- inlined into prompts) | 'zip' (central-directory-validated archive)
  -- | 'binary' (opaque pass-through for the coding agent)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  -- Kind-specific metadata captured at upload; for 'zip' the manifest
  -- { entryCount, uncompressedBytes, topLevel } from validateZip.
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE chat_session_attachments ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_session ON chat_session_attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_message ON chat_session_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_orphan
  ON chat_session_attachments(created_at) WHERE message_id IS NULL;

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids), and the bytes are private
-- chat content in their own right — screenshots and files a user shared
-- with their own dev session only. Schema-only in staging clones;
-- migrate.js seeds a demo fixture so the UI is exercisable there.
COMMENT ON TABLE chat_session_attachments IS 'staging:private';

-- Saved dev-chat drafts (#940). The composer's save icon parks typed text
-- as a DRAFT while a turn runs (#798, #810); until this table existed those
-- drafts lived only in the localStorage of the browser that typed them, so
-- a thought parked on a laptop was invisible on a phone and clearing site
-- data lost it silently. Now they belong to the ACCOUNT: the client keeps
-- localStorage as an instant-paint mirror + offline buffer and reconciles
-- against these rows on every session open.
--
-- draft_id is CLIENT-generated (DevChat._newDraftId, `d<base36><rand>`) and
-- validated against ^[A-Za-z0-9_-]{1,32}$ in the route. That is what makes
-- an upload idempotent (ON CONFLICT DO NOTHING) and lets two devices
-- recognise the same draft without a round trip; it is only ever a bound
-- parameter, never interpolated, and is always paired with session_id in
-- the primary key.
--
-- saved_at is the ordering key ("newest last", matching the render order),
-- with draft_id as the tiebreak because two devices can stamp the same
-- second. A client-supplied saved_at is clamped to [NOW() - 30 days, NOW()]
-- in the route so a device with a wrong clock can't pin a draft to the top
-- or to the far future.
--
-- Retention follows the parent session (ON DELETE CASCADE), bounded by a
-- 20-drafts-per-session cap enforced at insert time.
CREATE TABLE IF NOT EXISTS chat_session_drafts (
  session_id INTEGER     NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- Always the session owner. Stored so the ownership check and any
  -- per-user query is a single predicate on this table.
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id   VARCHAR(32) NOT NULL,
  content    TEXT        NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, draft_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_drafts_session
  ON chat_session_drafts(session_id, saved_at, draft_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_drafts_user
  ON chat_session_drafts(user_id);

-- Private like its parent chat_sessions — forced, not a preference: this
-- table FKs chat_sessions (public-FK-to-private is the combination the
-- clone's FK-closure discovery forbids), and the rows are unsent private
-- chat content in their own right. Schema-only in staging clones;
-- migrate.js seeds a demo fixture (session 990402) so the DB-backed path
-- is exercisable there.
COMMENT ON TABLE chat_session_drafts IS 'staging:private';

-- Fallback-title marker for the title auto-heal sweeper (services/
-- title-heal.js). TRUE when the PR's title came from the LLM-unavailable
-- fallback template ("<user>'s changes") — e.g. Anthropic credits ran out
-- or the API errored — instead of the generated one. The sweeper retries
-- generation while this is set and clears it on success; the vote panel
-- renders an "Auto-title pending" chip off the same flag so voters know
-- the placeholder isn't the real description of the change.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_title_fallback BOOLEAN NOT NULL DEFAULT FALSE;

-- The title an external agent submitted with a session update
-- (submit_work's `title`, stored by services/proposal-update.js). Used
-- verbatim when the session's pull request is lazily created at propose
-- time, instead of generating one — the fresh-task path already uses the
-- agent's title verbatim (prTitleFor), so a proposed session starting life
-- as "<user>'s changes · auto-title pending" was an asymmetry, not a
-- choice. One-shot: once a PR exists its own title governs, and later
-- interactive turns keep regenerating it as they always did. NULL for
-- sessions never updated through submit_work.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS proposed_pr_title TEXT;
-- #1323. The proposal's DESCRIPTION, mirrored from the pull request body so
-- get_proposal can report what the group is actually reading without a GitHub
-- round trip on a polled read path. Written by the create path and by an
-- author's own update; never the source of truth, which stays the PR itself.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_body TEXT;

-- Feedback issues filed with the fallback title ("Feedback from Usernode")
-- because the Haiku title call failed (routes/feedback.js). The issue is
-- filed immediately regardless — never block feedback on LLM availability —
-- and a row lands here so the title-heal sweeper can regenerate the title
-- from the stored description and PATCH the GitHub issue later. Rows are
-- deleted on success or abandoned after MAX_ATTEMPTS (title-heal.js);
-- next_attempt_at implements per-row exponential backoff.
CREATE TABLE IF NOT EXISTS title_heal_queue (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  issue_number    INTEGER NOT NULL,
  description     TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, repo, issue_number)
);
ALTER TABLE title_heal_queue
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_title_heal_queue_due ON title_heal_queue(next_attempt_at);

-- #683: drag-selected screenshots attached to filed GitHub issues from
-- the feedback modal. Bytea-in-Postgres like session_visuals (the
-- platform container has no persistent file volume); rows are served on
-- the public pre-auth GET /issue-images/:id route, so the unguessable
-- 32-hex id is the only privacy layer — same stance as visuals, and the
-- user explicitly published the image into a GitHub issue body.
-- issue_owner/repo/number are stamped when the issue is filed; rows
-- never linked (upload abandoned / modal cancelled) are GC'd by the
-- server.js orphan sweeper after 24h.
CREATE TABLE IF NOT EXISTS issue_screenshots (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type  VARCHAR(32) NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_issue_screenshots_orphan
  ON issue_screenshots(created_at) WHERE issue_number IS NULL;
-- Private: the bytea can contain anything visible on the reporter's
-- screen; staging gets the schema only.
COMMENT ON TABLE issue_screenshots IS 'staging:private';

-- #3940: video clips attached to filed GitHub issues from the feedback
-- modal. Bytea-in-Postgres like issue_screenshots above (the platform
-- container has no persistent file volume); rows are served on the
-- public pre-auth GET /issue-videos/:id route (with Range support, since
-- video playback and seeking ask for it), so the unguessable 32-hex id
-- is the only privacy layer — same stance as screenshots, and the clip
-- is already published into the GitHub issue body as a link. Only the
-- id, owner and link are stored; embeds stay plain markdown links, since
-- GitHub renders external <video> as an anchor anyway.
CREATE TABLE IF NOT EXISTS issue_videos (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type  VARCHAR(32) NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_issue_videos_orphan
  ON issue_videos(created_at) WHERE issue_number IS NULL;
-- Private: a screen recording can show anything the reporter's screen
-- showed; staging gets the schema only.
COMMENT ON TABLE issue_videos IS 'staging:private';

-- A local record of what somebody reported through the feedback dialog.
--
-- The dialog's real output is a GitHub issue, and that stays the case: this
-- table is a receipt, not a second source of truth. It exists because the
-- issue is the only trace a report leaves, and an issue cannot answer the
-- two questions the season's "send useful feedback" challenge asks — WHO on
-- this platform wrote it (GitHub sees the platform's bot account, not the
-- reporter) and WHEN, in a form the scorer can read without a GitHub round
-- trip per tick.
--
-- `target` is 'platform' or 'app'; `app_id` is set only for the second.
-- The issue coordinates are stamped after the issue is filed, so a report
-- whose GitHub call failed is simply absent — the scorer must never pay for
-- feedback that reached nobody. Deliberately no FK to `issues`: a platform
-- report files into the platform repo and has no `issues` row at all.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target        VARCHAR(16) NOT NULL,
  app_id        INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  title         VARCHAR(512),
  description   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_user_created
  ON feedback_reports (user_id, created_at DESC);
-- Private: free text a person wrote about their own use of the product,
-- and the grader reads it verbatim. Staging gets the schema only.
COMMENT ON TABLE feedback_reports IS 'staging:private';
-- #11 (WP3): where a report came from. NULL is the feedback dialog;
-- 'homeroom_bot' is a report the Homeroom bot filed for the person in its DM
-- (report_problem), which is rate-limited per person on this column.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS source VARCHAR(32);
-- #4803: immutable parts around the reporter's words. Keeping them separately
-- avoids parsing Markdown or rebuilding attachments when a typo is corrected.
-- NULL marks older and bot-filed reports, which have no edit window.
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS body_prefix TEXT;
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS body_suffix TEXT;
ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS edit_version INTEGER NOT NULL DEFAULT 0;

-- Group-chat file attachments (#694). Users attach files to group-chat
-- messages (images, markdown, standalone HTML, anything else as a
-- download). Same bytea-in-Postgres shape as chat_session_attachments
-- (#450): ids are random 32-hex tokens generated in Node; message_id is
-- NULL between upload and send — the WS 'chat' handler links it when the
-- message posts, and server.js's sweeper GCs orphans older than 24h.
-- Retention otherwise follows the parent message (ON DELETE CASCADE),
-- bounded by a 200 MB per-app cap at upload time.
CREATE TABLE IF NOT EXISTS chat_message_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'markdown'
  -- (.md/.markdown UTF-8, rendered in the chat's side panel) | 'html'
  -- (.html/.htm UTF-8, previewable only via the sandboxed /view route)
  -- | 'text' (other UTF-8, download-only) | 'binary' (opaque download)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_app ON chat_message_attachments(app_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_message ON chat_message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_orphan
  ON chat_message_attachments(created_at) WHERE message_id IS NULL;

-- staging:private: chat_messages itself is staging-copied (group chat is
-- shared content), but copying every app's attachment BLOBS into every
-- staging clone would balloon clone size for no testing value — the
-- migrate.js fixture seeds a demo message with attachments instead.
-- Private-FK-to-public is the allowed direction for the migration linter
-- (the forbidden combination is a public table FK'ing a private one).
COMMENT ON TABLE chat_message_attachments IS 'staging:private';

-- App file storage (#752): user-uploaded images apps store through the
-- platform (usernode.uploadFile() / POST /api/app-storage/files). This
-- table holds METADATA ONLY — the bytes live in the MinIO object-store
-- sidecar under key `app/<app_id>/<id>` (see services/app-files.js), so
-- the platform DB, its pg_dump backups, and self-app staging clones
-- never carry image payloads. Ids are random 16-byte hex, served on the
-- public pre-auth GET /app-files/:id route — the unguessable id is the
-- access control for visibility='public' rows (same stance as
-- app_icons); visibility='private' rows additionally require a valid
-- platform user JWT at serve time. `staging` marks uploads made from a
-- staging preview (bridge relay path); the server.js sweeper GCs those
-- after 7 days. Quota sums (per app / per app+user) read size_bytes.
CREATE TABLE IF NOT EXISTS app_files (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  visibility   VARCHAR(7)   NOT NULL DEFAULT 'public',
  staging      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_files_app ON app_files(app_id);
CREATE INDEX IF NOT EXISTS idx_app_files_app_user ON app_files(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_app_files_staging
  ON app_files(created_at) WHERE staging = TRUE;
-- Private: upload ownership is user content a staging clone has no
-- business seeing (same stance as issue_screenshots). Rows are metadata
-- only, so this is about privacy, not clone size. Private-FK-to-public
-- is the allowed linter direction.
COMMENT ON TABLE app_files IS 'staging:private';

-- Per-app credential for the app-storage API (#752), the exact
-- llm_proxy_token pattern: random 64-hex generated lazily at first
-- production deploy (services/app-storage-env.js), injected as
-- USERNODE_STORAGE_TOKEN into production containers only. Staging
-- deploys never receive it. Credential-bearing: tagged staging:private
-- AND listed in debug-access.js's DENIED_COLUMNS (the
-- prod-debug-access test cross-checks the two).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_api_token VARCHAR(64);
COMMENT ON COLUMN apps.storage_api_token IS 'staging:private';

-- ── Database-export audit log ────────────────────────────────────────
--
-- Append-only record of every attempt to download a full pg_dump of this
-- platform database from the admin console (/api/admin/db-export, see
-- src/services/db-export.js). Written BEFORE the dump is spawned, so an
-- export killed mid-stream — a deploy cutover, a crash — still leaves a
-- record; a boot sweep in migrate.js flips any row left `requested` /
-- `streaming` by a dead process to `interrupted`.
--
-- Nothing in the product ever UPDATEs a terminal row or DELETEs from this
-- table, and no admin UI exposes a way to clear it. That is the point:
-- the export hands out every credential in the platform, so the fact that
-- it happened must not be erasable from inside the app.
--
--   status        requested | streaming | completed | failed
--                 | cancelled | interrupted | denied
--   denied_reason bad_password | rate_limited | staging | view_only
--                 | in_progress | unavailable   (NULL unless denied)
--
-- user_id is ON DELETE SET NULL (mirroring `events`) so deleting a user
-- can never erase the history of what they exported; `username` is a
-- snapshot kept for exactly that case.
CREATE TABLE IF NOT EXISTS db_exports (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username      VARCHAR(255) NOT NULL,
  db_name       VARCHAR(255) NOT NULL,
  status        VARCHAR(32)  NOT NULL,
  denied_reason VARCHAR(64),
  ip            VARCHAR(64),
  user_agent    TEXT,
  bytes_sent    BIGINT       NOT NULL DEFAULT 0,
  requested_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_db_exports_requested ON db_exports (requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_db_exports_user ON db_exports (user_id, requested_at DESC);

-- Private for the same reason `events` is: an activity log carrying admin
-- usernames, source IPs and user agents that a staging preview has no
-- business carrying. NOT added to debug-access.js's DENIED_TABLES, and
-- that asymmetry is intentional — the deny lists exist for CREDENTIAL-
-- bearing data, and this table holds none (it records that an export
-- happened, never any exported content). A prod-debug session should be
-- able to read the export log; that's an audit trail, not a secret.
COMMENT ON TABLE db_exports IS 'staging:private';

-- ── Platform environment variables ───────────────────────────────────
--
-- In-platform management of the *platform's own* env vars — the ones
-- .github/workflows/deploy.yml writes into /opt/usernode/.env. Before
-- this, adding a tunable meant editing deploy.yml (a guardrailed file)
-- and adding a GitHub repo variable by hand, out of band from the
-- proposal that needed it, so a merged proposal could deploy straight
-- into a crash-loop on a variable nobody had set.
--
-- THE SURFACE is the platform app's own secrets panel, labelled "Platform
-- variables" (the "+" menu on its dev tab) — served by the self-hosted
-- branch of /api/apps/:slug/secrets* in routes/apps.js, with the vote path
-- riding kind='secret_change' like any other app's secrets. There is no
-- separate admin-console section: it existed briefly and was folded in,
-- because two screens describing one process's environment is how you get
-- an inert list of credentials with buttons that don't work.
--
-- Two tables, deliberately separate:
--
--   platform_env_declarations — a CACHE of the `platform_env` block in
--     the platform repo's committed dapp.json, refreshed on every boot
--     by app-manifest.reconcilePlatformEnv() from seedSelfApp(). The
--     manifest is the source of truth; this table exists so the panel
--     and the pre-merge check can query declarations in SQL instead of
--     re-reading the working tree, and so a value with no declaration
--     ("orphan") is detectable. NOT staging:private: it is a verbatim
--     copy of a public committed file.
--
--   platform_env_values — the SET VALUES (by an admin directly, or by an
--     applied secret_change vote), AES-256-GCM encrypted at rest by
--     services/secrets.js exactly as app_secrets is (same `v1:iv:tag:ct`
--     format, same JWT_SECRET-derived key). Resolved at deploy time,
--     never read by the running platform process — see the "Resolve
--     platform env" step in deploy.yml. Both write paths go through
--     services/platform-env.js so the unwritable-key and
--     private-from-declaration rules hold for either.
--
-- The value table is credential-bearing: tagged staging:private (so a
-- staging clone starts empty and the IS_STAGING seed fills it with
-- obvious fixtures) AND listed in debug-access.js's DENIED_TABLES, the
-- same treatment app_secrets gets.
--
-- A declaration is never required for a value to exist and vice versa:
-- removing a variable from dapp.json drops the declaration but KEEPS the
-- value, because the merge that removes it and the deploy that stops
-- using it are separate events and a rollback needs the value intact.
--
-- `unwritable` is derived by the manifest reader from
-- app-manifest.PLATFORM_ENV_UNWRITABLE, not declared: it marks a
-- variable that may be documented here but whose value comes straight
-- from a GitHub secret at deploy time and can never be written through
-- the admin UI (JWT_SECRET, DATABASE_URL, the GitHub App credentials…).
CREATE TABLE IF NOT EXISTS platform_env_declarations (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key           VARCHAR(128) NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  required      BOOLEAN NOT NULL DEFAULT FALSE,
  private       BOOLEAN NOT NULL DEFAULT FALSE,
  grouping      VARCHAR(64) NOT NULL DEFAULT 'General',
  default_value TEXT,
  unwritable    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, key)
);

CREATE TABLE IF NOT EXISTS platform_env_values (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key         VARCHAR(128) NOT NULL,
  value_enc   TEXT NOT NULL,
  value_last4 VARCHAR(8),
  private     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, key)
);
COMMENT ON TABLE platform_env_values IS 'staging:private';

-- Display-only mirror of the platform-env pre-merge check for a proposal
-- (see src/services/platform-env-check.js). Deliberately NOT folded into
-- chat_sessions.check_state: that column is owned by the staging-capture
-- pipeline and rewritten wholesale on every storeChecks() run, which
-- would clobber a verdict computed from a different input (the diff
-- against main, not a browser run). These columns feed the Checks card;
-- the merge gate in routes/votes.js re-evaluates LIVE rather than
-- trusting them, so a variable set between the last check run and the
-- final vote unblocks the merge without a re-check.
--
--   platform_env_state  : 'passing' | 'failing' | 'skipped' | 'error'
--                         (NULL until the first evaluation)
--   platform_env_detail : { missing:[{key,required,description}],
--                           added:[key], removed:[key], reason }
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_state TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_detail JSONB;

-- ══════════════════════════════════════════════════════════════════
-- Declaring a BRAND-NEW secret / platform variable from the panel.
--
-- The App secrets panel can set values for keys `dapp.json` already
-- declares. Adding a key needs TWO things to land: the manifest
-- DECLARATION (only ever changeable by a merged PR — see
-- services/rename-pr.js, the single writer of dapp.json) and the
-- VALUE (app_secrets / platform_env_values). This table is where the
-- value waits while its declaration PR is up for vote, so ONE
-- proposal carries both halves.
--
-- One row per proposed key, bound to the declaration PR's
-- chat_sessions row:
--   status='pending'   the PR is open; the value (if any) is held here
--   status='applied'   the PR merged and the value was written to the
--                      real store by the merge (the merge-followups
--                      workflow machine)
--   status='discarded' the PR was withdrawn / voted down
--
-- `value_enc` is NULL in two legitimate cases: no value was supplied
-- (a declaration-only proposal, e.g. one that only documents a
-- default), or the proposer was a full admin, who is already allowed
-- to write values directly — those go straight to the real store and
-- the row records `value_applied_at` so the panel can say
-- "value set, declaration up for vote".
--
-- Credential-bearing exactly like app_secrets: staging:private (a
-- clone starts empty; the IS_STAGING seed fills it with obvious
-- fixtures) AND in debug-access.js's DENIED_TABLES.
CREATE TABLE IF NOT EXISTS pending_secret_declarations (
  id              SERIAL PRIMARY KEY,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  key             VARCHAR(128) NOT NULL,
  declaration     JSONB NOT NULL,
  value_enc       TEXT,
  value_last4     VARCHAR(8),
  value_applied_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE pending_secret_declarations IS 'staging:private';
-- One live proposal per key per app. Partial index rather than a plain
-- UNIQUE so the applied/discarded history can hold many rows for the
-- same key (a variable declared, removed, and declared again).
CREATE UNIQUE INDEX IF NOT EXISTS pending_secret_decl_live_key
  ON pending_secret_declarations (app_id, key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pending_secret_decl_session
  ON pending_secret_declarations (session_id);

-- ══════════════════════════════════════════════════════════════════
-- Topochain (testnet competition) — SPEC §3.4 schema
--
-- Topochain becomes a native part of this platform: a testnet
-- competition organized as Season → Event → Challenge.
--   Season          the top-level competition period (`seasons`).
--   Season Event    a phase within a season (`season_events` — named
--                   with the full word "season_event" everywhere,
--                   never "event", because the platform already owns
--                   an unrelated analytics table called `events`).
--   Challenge       a task instance scoped to one season_event,
--                   itself an instantiation of a reusable
--                   `challenge_templates` row (`challenges`).
-- Users earn points by completing challenges and producing blocks;
-- `user_activities` is the append-only ledger of both, scored into
-- periodic `leaderboard_snapshots`.
--
-- Source: topochain's own Postgres database, migrated table-for-table
-- per docs/migration/usernode-migration.md §3.4 (line-referenced
-- below as "SPEC"). SPEC wins over convenience for every exact type,
-- default, and index. `users.id` here is the platform's SERIAL/
-- INTEGER primary key; every FK column below is BIGINT as specced —
-- Postgres allows a bigint column to reference an integer primary key
-- (int4/int8 share a btree operator family), so no type downgrade is
-- needed to keep the FK real.
--
-- Every CREATE is IF NOT EXISTS / guarded so this whole file can run
-- as one boot-time multi-statement query, every boot, forever.
-- ══════════════════════════════════════════════════════════════════

-- `seasons` — the top level of Season → Event → Challenge. One row
-- per competition period (e.g. "Season 1"). `pool_info` is a free-text
-- description of the token pool being distributed; `internal` flags a
-- season not meant for public display (staff dry-runs).
CREATE TABLE IF NOT EXISTS seasons (
  id             BIGSERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  internal       BOOLEAN NOT NULL DEFAULT FALSE,
  display_order  INTEGER NOT NULL DEFAULT 0,
  pool_info      VARCHAR(255),
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_seasons_display_order ON seasons (display_order);
CREATE INDEX IF NOT EXISTS idx_seasons_is_active ON seasons (is_active);
CREATE INDEX IF NOT EXISTS idx_seasons_starts_ends ON seasons (starts_at, ends_at);

-- `season_events` — the Event level of Season → Event → Challenge, one
-- phase of a season. Named `season_events` (not `events`) because the
-- platform already has an unrelated `events` analytics table; every FK
-- to this table is named `season_event_id` in full, never `event_id`.
-- `account_source_season_event_id` is a self-referential FK used for
-- account inheritance between events (`account_inheritance_mode`
-- governs whether/how onchain_accounts carry over from a prior event).
-- `chain_id` deliberately stays TEXT with no FK — it is a free-form
-- match against `chains.chain_id` values, which are not unique per row
-- there either (chains is an append-only block log).
CREATE TABLE IF NOT EXISTS season_events (
  id                                BIGSERIAL PRIMARY KEY,
  name                              VARCHAR(255) NOT NULL,
  description                       TEXT,
  starts_at                         TIMESTAMPTZ NOT NULL,
  ends_at                           TIMESTAMPTZ NOT NULL,
  is_active                         BOOLEAN NOT NULL DEFAULT TRUE,
  scoring_formula                   JSONB NOT NULL,
  created_at                        TIMESTAMPTZ,
  updated_at                        TIMESTAMPTZ,
  start_epoch                       BIGINT,
  end_epoch                         BIGINT,
  internal                          BOOLEAN NOT NULL DEFAULT FALSE,
  disclaimer                        TEXT,
  display_leaderboard               BOOLEAN NOT NULL DEFAULT TRUE,
  score_start_time                  TIMESTAMPTZ,
  score_end_time                    TIMESTAMPTZ,
  display_disclaimer                BOOLEAN NOT NULL DEFAULT FALSE,
  chain_id                          TEXT,
  rank_based_on_bp_or_success_rate  VARCHAR(255) NOT NULL DEFAULT 'BP',
  display_activities                BOOLEAN NOT NULL DEFAULT FALSE,
  season_id                         BIGINT REFERENCES seasons(id) ON DELETE CASCADE,
  type                              VARCHAR(20) NOT NULL DEFAULT 'regular',
  account_inheritance_mode          VARCHAR(32) NOT NULL DEFAULT 'none',
  account_source_season_event_id    BIGINT REFERENCES season_events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_season_events_epoch_range ON season_events (start_epoch, end_epoch);
CREATE INDEX IF NOT EXISTS idx_season_events_display_activities ON season_events (display_activities);
CREATE INDEX IF NOT EXISTS idx_season_events_is_active ON season_events (is_active);
CREATE INDEX IF NOT EXISTS idx_season_events_starts_ends ON season_events (starts_at, ends_at);

-- `user_enrollments` — a user enrolled either in an entire season
-- (`season_event_id` NULL) or in one specific event (`season_event_id`
-- set). `season_id` is always set (denormalized from the event when
-- event-scoped) so "everyone in season X" is a single-column filter.
-- Invariant (app/ETL-enforced, no cross-table CHECK): when
-- season_event_id is set, season_id must equal that event's season_id.
-- Two partial uniques — rather than one composite — let season-wide
-- and per-event enrollments coexist without NULL-uniqueness surprises.
CREATE TABLE IF NOT EXISTS user_enrollments (
  id               BIGSERIAL PRIMARY KEY,
  season_event_id  BIGINT REFERENCES season_events(id) ON DELETE CASCADE,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id        BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_event_unique
  ON user_enrollments (user_id, season_event_id) WHERE season_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_unique
  ON user_enrollments (user_id, season_id) WHERE season_event_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_enrollments_season ON user_enrollments (season_id);
CREATE INDEX IF NOT EXISTS idx_user_enrollments_season_event ON user_enrollments (season_event_id);
CREATE INDEX IF NOT EXISTS idx_user_enrollments_user ON user_enrollments (user_id);

-- `challenge_kinds` — the taxonomy scanners key off (a flat slug list,
-- not hierarchical — the sibling `category` column on templates stays
-- free text with no table behind it). PK is a VARCHAR(100) slug such
-- as REPORT_BUG_CHALLENGE / SEND_TX_CHALLENGE.
CREATE TABLE IF NOT EXISTS challenge_kinds (
  id           VARCHAR(100) PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ
);
-- The picture a challenge of this kind shows on the launcher's Challenges
-- cards. It lives on the KIND rather than on the template or the challenge
-- because that is the controlled vocabulary an organiser already picks from
-- (`challenge_templates.kind` is a real FK to this table), so one setting
-- gives every challenge of that kind the same face — which is what makes a
-- column of cards scannable rather than a column of different drawings.
--
-- One or two characters, so an emoji including the joined ones. Anything
-- longer is refused by the writer; anything absent (a kind with no icon, or
-- a template with no kind at all) falls back to the challenge's category
-- word, which is the only other per-challenge mark there is.
ALTER TABLE challenge_kinds ADD COLUMN IF NOT EXISTS icon VARCHAR(16);

-- `challenge_templates` — a reusable challenge definition; one or more
-- `challenges` rows instantiate it per event (referenced there as
-- `challenge_template_id`). `kind` carries a real FK to
-- `challenge_kinds(id)` (the source only validated this in app code).
CREATE TABLE IF NOT EXISTS challenge_templates (
  id                BIGSERIAL PRIMARY KEY,
  category          VARCHAR(50) NOT NULL,
  goal              VARCHAR(255) NOT NULL,
  task              TEXT NOT NULL,
  reward            VARCHAR(255) NOT NULL,
  description       TEXT,
  requirements      TEXT,
  schedule_start    TIMESTAMPTZ,
  schedule_end      TIMESTAMPTZ,
  reward_logic      TEXT,
  cta_button        VARCHAR(255),
  cta_label         VARCHAR(255),
  cta_link          TEXT,
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  kind              VARCHAR(100) REFERENCES challenge_kinds(id) ON DELETE SET NULL,
  cta_type          VARCHAR(10),
  mobile_cta_type   VARCHAR(10),
  mobile_cta_label  VARCHAR(255),
  mobile_cta_link   TEXT,
  metric_type       VARCHAR(30),
  metric_target     NUMERIC(20,4),
  metric_label      VARCHAR(255),
  illustration      VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_challenge_templates_category ON challenge_templates (category);
-- The artwork a challenge made from this template draws on its card and on
-- its detail page. It lives on the TEMPLATE, not the challenge, because a
-- picture describes what the challenge asks for, and that is what the
-- template defines; every event that reuses the template keeps the same face.
--
-- A slug naming a file under /illustrations/challenges/, never a URL. The
-- writer checks only its SHAPE; the client draws it only when the slug is in
-- its own registry, so a slug from a newer or older build simply falls back to
-- the kind icon rather than requesting a file that is not there. NULL is the
-- ordinary case and draws that same fallback.
--
-- Declared in the table above for fresh databases; the ALTER is what reaches
-- the ones that already have it, since migrate.js replays this file each boot.
ALTER TABLE challenge_templates ADD COLUMN IF NOT EXISTS illustration VARCHAR(64);

-- Illustrations an admin uploaded from the template form's gallery, beside the
-- nine built-in drawings under /illustrations/challenges/. A template names one
-- in that same `illustration` column as `u-` plus the row's id, so the column
-- needs no second shape and no foreign key: a slug whose row is missing draws
-- the kind icon, exactly like a built-in slug from another build.
--
-- `id` is a random 32-hex string that doubles as the public file id, served at
-- /challenge-illustrations/<id> with an immutable cache header, so the bytes
-- under an id never change. `tone` is one of the twelve harmonic tones the card
-- paints behind the art, and travels to the client beside the slug. Rows are
-- never deleted: `archived` hides one from the gallery while every template
-- already using it keeps drawing it. An SVG row passed the strict allowlist in
-- src/services/svg-safety.js before it was stored.
CREATE TABLE IF NOT EXISTS challenge_illustrations (
  id            VARCHAR(32) PRIMARY KEY,
  slug          VARCHAR(64) NOT NULL UNIQUE,
  label         VARCHAR(80) NOT NULL,
  tone          VARCHAR(16) NOT NULL,
  content_type  TEXT NOT NULL,
  data          BYTEA NOT NULL,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `challenges` — the Challenge level of Season → Event → Challenge: an
-- instance of a `challenge_templates` row scoped to one season_event,
-- overriding whatever fields it needs. Challenge completions are NOT a
-- separate table (the source's completion tables are excluded) — every
-- completion is a `user_activities` row instead (see the two replay-
-- protection indexes on that table below).
-- `challenge_template_id` deliberately has NO ON DELETE action (defaults
-- to NO ACTION/RESTRICT): SPEC §D4 calls the source's cascading template
-- delete "destructive with no guard" (it silently wipes every challenge
-- using the type, and transitively their scored user_activities history)
-- and says v4 must REFUSE deletion while challenges still reference the
-- template. Unlike season_events → challenges (a real CASCADE further
-- up this table), this FK is the database backstop for that refusal —
-- the admin API's own guard (a later task) is the primary UX, but a
-- direct DB delete must still fail closed, not cascade.
CREATE TABLE IF NOT EXISTS challenges (
  id                     BIGSERIAL PRIMARY KEY,
  season_event_id        BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  challenge_template_id  BIGINT NOT NULL REFERENCES challenge_templates(id),
  goal                   VARCHAR(255),
  task                   TEXT,
  reward                 VARCHAR(255),
  description            TEXT,
  requirements           TEXT,
  schedule_start         TIMESTAMPTZ,
  schedule_end           TIMESTAMPTZ,
  reward_logic           TEXT,
  cta_button             VARCHAR(255),
  cta_label              VARCHAR(255),
  cta_link               TEXT,
  created_at             TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ,
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  display_order          INTEGER NOT NULL DEFAULT 0,
  completed              BOOLEAN NOT NULL DEFAULT FALSE,
  kind                   VARCHAR(100) REFERENCES challenge_kinds(id) ON DELETE SET NULL,
  cta_type               VARCHAR(10),
  mobile_cta_type        VARCHAR(10),
  mobile_cta_label       VARCHAR(255),
  mobile_cta_link        TEXT,
  metric_type            VARCHAR(30),
  metric_target          NUMERIC(20,4),
  metric_label           VARCHAR(255),
  featured               BOOLEAN NOT NULL DEFAULT FALSE,
  featured_order         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_challenges_completed ON challenges (completed);
CREATE INDEX IF NOT EXISTS idx_challenges_display_order ON challenges (display_order);
CREATE INDEX IF NOT EXISTS idx_challenges_enabled ON challenges (enabled);
CREATE INDEX IF NOT EXISTS idx_challenges_featured ON challenges (featured);
CREATE INDEX IF NOT EXISTS idx_challenges_challenge_template ON challenges (challenge_template_id);
CREATE INDEX IF NOT EXISTS idx_challenges_season_event ON challenges (season_event_id);
CREATE INDEX IF NOT EXISTS idx_challenges_season_event_display_order ON challenges (season_event_id, display_order);

-- `user_activities` — the append-only points ledger: one row per
-- completed challenge OR per block-production credit. `added_by` is a
-- soft reference to a source admin user (admins are not migrated, so
-- it carries no FK and is simply left NULL for migrated rows).
-- `source` keeps the original enum verbatim ('admin_ui', scanner/agent
-- values); agent rows remain valid history even though agent tables
-- are excluded from this migration.
CREATE TABLE IF NOT EXISTS user_activities (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_event_id  BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  activity_type    VARCHAR(100) NOT NULL,
  points           NUMERIC(10,2) NOT NULL DEFAULT 0,
  description      TEXT,
  metadata         JSONB,
  activity_at      TIMESTAMPTZ NOT NULL,
  added_by         BIGINT,
  source           VARCHAR(255) NOT NULL DEFAULT 'admin_ui',
  created_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ,
  challenge_id     BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_activities_activity_type ON user_activities (activity_type);
CREATE INDEX IF NOT EXISTS idx_user_activities_user_season_event ON user_activities (user_id, season_event_id);

-- Anti-replay after dropping the source's completion tables (SPEC
-- §4.10): the source enforced "one completion per (user, challenge)"
-- and "one claim per (challenge, zkPassport nullifier)" at the
-- database level via those tables; recording completions as
-- `user_activities` rows keeps the points but drops the constraints
-- unless restored here. Restored as partial unique indexes over
-- expression values pulled from `metadata`, verbatim per spec.
CREATE UNIQUE INDEX IF NOT EXISTS user_activities_completion_unique
  ON user_activities (user_id, challenge_id)
  WHERE metadata->>'kind' = 'challenge_completion';

CREATE UNIQUE INDEX IF NOT EXISTS user_activities_nullifier_unique
  ON user_activities (challenge_id, (metadata->>'nullifier_hex'))
  WHERE metadata->>'nullifier_hex' IS NOT NULL;

-- The same idea for the automatic scorer
-- (services/topochain/challenge-scorer.js): a credit names the thing it was
-- paid for in `metadata.source_key` ("app:12", "pr_merged:4417",
-- "provider:github"), and this index is what makes re-running the scorer
-- free. A tick re-reads the same app sessions and merged proposals every
-- ten minutes; without a database-level rule, an interrupted tick or two
-- instances briefly overlapping would pay twice. INSERT ... ON CONFLICT DO
-- NOTHING against this index is the whole de-duplication design — the
-- scorer keeps no cursor and no "already processed" table.
--
-- Scoped to (challenge, user) rather than to the key alone because the key
-- namespace is per-rule: two challenges may legitimately both credit
-- "app:12", and a weekly challenge re-instantiated next week is a NEW
-- challenge row that must be able to pay for the same app again.
CREATE UNIQUE INDEX IF NOT EXISTS user_activities_source_key_unique
  ON user_activities (challenge_id, user_id, (metadata->>'source_key'))
  WHERE metadata->>'source_key' IS NOT NULL;

-- `challenge_scoring_rules` — what the automatic scorer is told to do.
--
-- One row is one rule: a MEASURE the platform knows how to take, the numbers
-- it takes it with, and the challenge it pays into. Admins create and edit
-- these from the programme console's Challenge scoring screen; the scorer
-- reads them every tick. A challenge with no rule is never scored, which is
-- what keeps this opt-in rather than something that starts crediting the
-- moment a template is created.
--
-- `measure` is a slug from a fixed list the code implements
-- (services/topochain/challenge-rules.js: TRY_APPS, USE_APPS_MINUTES,
-- PROPOSAL_SENT, PROPOSAL_ACCEPTED, USEFUL_FEEDBACK, CONNECT_ACCOUNTS,
-- BLOCK_PRODUCTION_ON, COMMUNITY_JOINED, COMMUNITY_APP_CREATED,
-- INVITES_JOINED, VOTE_CAST, FEEDBACK_SENT). Deliberately NOT free-form
-- logic: the thing that decides who gets points has to be reviewable and
-- testable, so what an admin composes is the CONFIGURATION of a measure,
-- never its body. It is
-- also NOT `challenges.kind` — that column already means something to the
-- phone app (which behaviour a card gets) and to the illustration picker,
-- and overloading it would tie "how this is scored" to "how this is drawn".
--
-- Binding, and why a template binding is the useful one: a weekly challenge
-- is re-instantiated as a NEW `challenges` row every week, so a rule bound to
-- one challenge would stop working at the week boundary. A rule naming
-- `challenge_template_id` covers every challenge stamped from that template,
-- this week's and next week's. `challenge_id` narrows it to a single
-- instance when an operator wants exactly that. Exactly one of the two is
-- set, which the CHECK enforces.
--
-- `target` and `points` are overrides. Left NULL, the rule uses the
-- challenge's own `metric_target` and `reward`, so the numbers a participant
-- reads on the card are the numbers they are paid by — one place to change
-- them, and no way for the copy and the scoring to drift apart. They exist
-- because a reward is prose ("Up to 2,000 pts") that does not always parse,
-- and because a target is sometimes needed where the card shows no counter.
CREATE TABLE IF NOT EXISTS challenge_scoring_rules (
  id                     BIGSERIAL PRIMARY KEY,
  name                   VARCHAR(120) NOT NULL,
  measure                VARCHAR(40) NOT NULL,
  challenge_template_id  BIGINT REFERENCES challenge_templates(id) ON DELETE CASCADE,
  challenge_id           BIGINT REFERENCES challenges(id) ON DELETE CASCADE,
  target                 NUMERIC(20,4),
  points                 NUMERIC(10,2),
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT challenge_scoring_rules_one_binding CHECK (
    (challenge_template_id IS NOT NULL AND challenge_id IS NULL)
    OR (challenge_template_id IS NULL AND challenge_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_challenge_scoring_rules_template
  ON challenge_scoring_rules (challenge_template_id);
CREATE INDEX IF NOT EXISTS idx_challenge_scoring_rules_challenge
  ON challenge_scoring_rules (challenge_id);
-- One enabled rule per binding: two rules on one challenge would both credit
-- it, and "why did this pay twice" is a bad thing to debug in a live season.
CREATE UNIQUE INDEX IF NOT EXISTS challenge_scoring_rules_template_unique
  ON challenge_scoring_rules (challenge_template_id) WHERE challenge_template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS challenge_scoring_rules_challenge_unique
  ON challenge_scoring_rules (challenge_id) WHERE challenge_id IS NOT NULL;
-- Each rule runs on its own interval. The scheduler is one timer beating once
-- a minute; on each beat a rule is due when `interval_minutes` have passed
-- since `last_scored_at`. NULL interval follows the deployment's default
-- (CHALLENGE_SCORER_INTERVAL_MINUTES), so a rule nobody has touched runs as
-- often as the whole service did before this column existed. The allowed
-- values are a fixed list in code (challenge-rules.js INTERVAL_CHOICES); the
-- CHECK here is only the belt that keeps a hand-written UPDATE sane.
--
-- `last_scored_at` moves only when a pass ran to its end. A pass cut short by
-- the run's shared budget leaves it alone, so the rule is still due on the
-- next beat and — having waited longest — first in line for it.
--
-- `last_pass` is what that pass cost: milliseconds, candidates read, credits
-- written, units graded. It lives on the rule because the run history keeps
-- ten runs, and with one rule on a one-minute interval those ten are all
-- that rule's.
ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS interval_minutes INTEGER
  CHECK (interval_minutes IS NULL OR (interval_minutes >= 1 AND interval_minutes <= 1440));
ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS last_scored_at TIMESTAMPTZ;
ALTER TABLE challenge_scoring_rules ADD COLUMN IF NOT EXISTS last_pass JSONB;

-- What the automatic scorer did, each time it ran.
--
-- The credits themselves are the ledger rows above; this is the operator's
-- view of the machine that wrote them. Without it the scorer is invisible
-- between runs: an admin looking at a quiet week cannot tell whether nobody
-- earned anything, the tick has been failing since Tuesday, or grading is
-- off because the API key is missing. `summary` carries the per-challenge
-- breakdown (credits written, units skipped, grades made) and doubles as
-- the DRY RUN output — a dry run records what it WOULD have written and
-- writes no ledger rows at all.
--
-- `trigger` is 'schedule' or 'admin'. Rows are small and infrequent (one
-- per tick), and the admin screen reads only the newest few.
CREATE TABLE IF NOT EXISTS challenge_scorer_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  trigger      VARCHAR(16) NOT NULL DEFAULT 'schedule',
  dry_run      BOOLEAN NOT NULL DEFAULT FALSE,
  credits      INTEGER NOT NULL DEFAULT 0,
  summary      JSONB,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenge_scorer_runs_started
  ON challenge_scorer_runs (started_at DESC);

-- `onchain_accounts` — a testnet account (address + keys) granted to a
-- user, scoped to a season or to a single event, mirroring
-- `user_enrollments`: `season_id` is always set, `season_event_id` is
-- nullable, and a NULL event means the account is granted for the
-- whole season. Invariant (app/ETL-enforced): when season_event_id is
-- set, season_id must equal that event's season_id. Two partial
-- uniques keep season-scoped and event-scoped accounts from colliding
-- on the same public key. Event-scoped rows are legacy history (Season
-- 1 recycled keys between users mid-season, so they cannot satisfy any
-- per-user uniqueness); from Pre Season 2 onward accounts are created
-- season-scoped only, and the third partial unique below enforces the
-- model's core rule: a user holds at most ONE season-scoped account
-- per season. `secret_key` is a real testnet credential —
-- handled like `apps.db_password` elsewhere in this schema: scrubbed
-- in staging and denied from prod-debug access (wired in Task 2).
-- `address` (ut1…) is the participant-facing account; `public_key`
-- (utpk1… hash source) is the VRF-side key.
CREATE TABLE IF NOT EXISTS onchain_accounts (
  id                 BIGSERIAL PRIMARY KEY,
  amount             BIGINT NOT NULL,
  identity_uid       VARCHAR(64) NOT NULL,
  address            VARCHAR(100) NOT NULL,
  public_key         VARCHAR(64) NOT NULL,
  secret_key         VARCHAR(64) NOT NULL,
  tier               VARCHAR(50) NOT NULL,
  description        TEXT,
  registration_code  VARCHAR(64) NOT NULL UNIQUE,
  season_event_id    BIGINT REFERENCES season_events(id) ON DELETE CASCADE,
  season_id          BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id            BIGINT REFERENCES users(id) ON DELETE SET NULL,
  is_used            BOOLEAN NOT NULL DEFAULT FALSE,
  used_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_event_public_key_unique
  ON onchain_accounts (season_event_id, public_key) WHERE season_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_public_key_unique
  ON onchain_accounts (season_id, public_key) WHERE season_event_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_user_season_unique
  ON onchain_accounts (user_id, season_id)
  WHERE user_id IS NOT NULL AND season_event_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_id_user_uidx
  ON onchain_accounts (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_id_user_address_uidx
  ON onchain_accounts (id, user_id, address);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_user ON onchain_accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season ON onchain_accounts (season_id);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season_event_address ON onchain_accounts (season_event_id, address);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_address ON onchain_accounts (address);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_identity_uid ON onchain_accounts (identity_uid);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_public_key ON onchain_accounts (public_key);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_user_season_event_used ON onchain_accounts (user_id, season_event_id, is_used);
CREATE INDEX IF NOT EXISTS idx_onchain_accounts_season_event_used ON onchain_accounts (season_event_id, is_used);

-- `account_delegation_periods` — when a testnet account (`account`, a
-- ut1… address matching `onchain_accounts.address`) had its stake
-- delegated. Deliberately no FK: delegations can reference accounts
-- from any event/season, and the source table wasn't scoped that way.
-- HISTORY MODEL: every period is kept. The invariant is the partial
-- unique index below — at most one OPEN period (`ended_at IS NULL`) per
-- account — not a full unique on `account`; re-delegation inserts a new
-- row and closed rows are immutable history (SPEC 1451's audit trail).
CREATE TABLE IF NOT EXISTS account_delegation_periods (
  id          BIGSERIAL PRIMARY KEY,
  account     VARCHAR(255) NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ
);
-- Existing databases converge from the pre-history model: drop the old
-- column-level unique (its rows are already valid under the new
-- invariant — one row per account trivially has at most one open one).
ALTER TABLE account_delegation_periods DROP CONSTRAINT IF EXISTS account_delegation_periods_account_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_delegation_periods_open
  ON account_delegation_periods (account) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_account_delegation_periods_account_ended ON account_delegation_periods (account, ended_at);

-- `leaderboard_snapshots` — point-in-time leaderboard rows, one per
-- (season_event, user, snapshot_at). With the source's
-- `global_leaderboard` table excluded from this migration, this is
-- the ONLY persisted leaderboard; any all-time/global view is derived
-- from it at query time (see the standings service, Task 5).
-- `extra_points` holds points awarded outside block production (the
-- source called this `offchain_points`; API payloads use the new
-- name). `challenge_details` was already JSONB in the source.
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id                                       BIGSERIAL PRIMARY KEY,
  season_event_id                          BIGINT NOT NULL REFERENCES season_events(id) ON DELETE CASCADE,
  user_id                                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank                                     INTEGER NOT NULL,
  total_points                             NUMERIC(15,2) NOT NULL DEFAULT 0,
  extra_points                             NUMERIC(15,2) NOT NULL DEFAULT 0,
  snapshot_at                              TIMESTAMPTZ NOT NULL,
  created_at                               TIMESTAMPTZ,
  updated_at                               TIMESTAMPTZ,
  last_epoch_total_produced_blocks         BIGINT NOT NULL DEFAULT 0,
  event_total_produced_blocks              BIGINT NOT NULL DEFAULT 0,
  event_success_rate                       NUMERIC(5,2),
  epoch_success_rate                       NUMERIC(5,2),
  first_block_points                       INTEGER NOT NULL DEFAULT 0,
  produced_half_blocks_points              INTEGER NOT NULL DEFAULT 0,
  top_3_points                             INTEGER NOT NULL DEFAULT 0,
  success_50_percent_points                INTEGER NOT NULL DEFAULT 0,
  bug_report_points                        INTEGER NOT NULL DEFAULT 0,
  inviting_new_participant_points          INTEGER NOT NULL DEFAULT 0,
  community_contribution_points            INTEGER NOT NULL DEFAULT 0,
  vrf_total_won_slots                      INTEGER NOT NULL DEFAULT 0,
  canonical_total_won_slots                INTEGER NOT NULL DEFAULT 0,
  canonical_total_produced_blocks          INTEGER NOT NULL DEFAULT 0,
  canonical_won_slots_up_to_current        INTEGER NOT NULL DEFAULT 0,
  canonical_produced_blocks_up_to_current  INTEGER NOT NULL DEFAULT 0,
  max_bp_success_rate_up_to_current        NUMERIC(5,2) NOT NULL DEFAULT 0,
  season_id                                BIGINT,
  challenge_details                        JSONB,
  UNIQUE (season_event_id, user_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_season_event_rank ON leaderboard_snapshots (season_event_id, rank);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_season_event_snapshot ON leaderboard_snapshots (season_event_id, snapshot_at);

-- `token_allocation` — the financial record of tokens allocated to a
-- user for a season. `updated_by` referenced a source admin user;
-- admins are not migrated, so it is a soft (no-FK) column, left NULL.
CREATE TABLE IF NOT EXISTS token_allocation (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id            BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  total_points         NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_season_tokens  NUMERIC(18,2) NOT NULL DEFAULT 0,
  allocated_tokens     NUMERIC(30,8) NOT NULL DEFAULT 0,
  description          VARCHAR(255),
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ,
  updated_by           BIGINT,
  UNIQUE (user_id, season_id)
);
CREATE INDEX IF NOT EXISTS idx_token_allocation_updated_by ON token_allocation (updated_by);

-- `epoch_stats` — per-(chain, wallet, epoch) block-production tallies.
-- `wallet_address` is kept alongside the nullable `user_id` because
-- stats can exist for wallets never linked to a platform user; a
-- deleted user's history stays (SET NULL, not CASCADE).
CREATE TABLE IF NOT EXISTS epoch_stats (
  id                      BIGSERIAL PRIMARY KEY,
  chain_id                VARCHAR(64) NOT NULL,
  wallet_address          VARCHAR(255) NOT NULL,
  user_id                 BIGINT REFERENCES users(id) ON DELETE SET NULL,
  epoch                   INTEGER NOT NULL,
  epoch_won_slots         INTEGER NOT NULL DEFAULT 0,
  epoch_produced_blocks   INTEGER NOT NULL DEFAULT 0,
  epoch_canonical_blocks  INTEGER NOT NULL DEFAULT 0,
  epoch_orphaned_blocks   INTEGER NOT NULL DEFAULT 0,
  epoch_failed_blocks     INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ,
  UNIQUE (chain_id, epoch, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_epoch_stats_chain_epoch ON epoch_stats (chain_id, epoch);

-- `chains` — append-only block log (public chain data). No FKs by
-- design: `chain_id` is a free-form value, not a foreign key to
-- anything, since this table itself never carries a unique
-- (chain_id) row. Currently 0 rows in the source; schema only.
CREATE TABLE IF NOT EXISTS chains (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      VARCHAR(64) NOT NULL,
  global_slot   BIGINT NOT NULL,
  block_height  BIGINT NOT NULL,
  slot_time     TIMESTAMPTZ NOT NULL,
  canonical     BOOLEAN NOT NULL,
  block_hash    VARCHAR(255) NOT NULL,
  producer      VARCHAR(255) NOT NULL,
  predecessor   VARCHAR(255),
  epoch         INTEGER NOT NULL,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chains_block_height ON chains (block_height);
CREATE INDEX IF NOT EXISTS idx_chains_canonical ON chains (canonical);
CREATE INDEX IF NOT EXISTS idx_chains_chain_id ON chains (chain_id);
CREATE INDEX IF NOT EXISTS idx_chains_epoch ON chains (epoch);
CREATE INDEX IF NOT EXISTS idx_chains_global_slot ON chains (global_slot);

-- `bytea_larger` / `max(bytea)` — the source database defines a custom
-- MAX() aggregate over bytea (its own migration 2026_05_18_000003) so
-- queries can take the largest `vrf_obligations.vrf_output_be_bytes`
-- value. Postgres ships no built-in bytea ordering aggregate, so it is
-- recreated here: an IMMUTABLE helper function picks the larger of two
-- (byte-wise) bytea values, NULL-safe, and a custom aggregate folds it
-- across rows. `CREATE AGGREGATE` has no IF NOT EXISTS / OR REPLACE
-- form, so it is guarded by checking pg_proc/pg_aggregate directly —
-- the same idempotency this whole file relies on everywhere else.
CREATE OR REPLACE FUNCTION bytea_larger(a BYTEA, b BYTEA) RETURNS BYTEA AS $$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    WHEN a > b THEN a
    ELSE b
  END;
$$ LANGUAGE SQL IMMUTABLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_aggregate ag
      JOIN pg_proc p ON p.oid = ag.aggfnoid
      JOIN pg_type t ON t.oid = p.proargtypes[0]
     WHERE p.proname = 'max' AND t.typname = 'bytea'
  ) THEN
    CREATE AGGREGATE max(BYTEA) (
      SFUNC = bytea_larger,
      STYPE = BYTEA
    );
  END IF;
END $$;

-- `vrf_obligations` — the largest migrated table by far (source has
-- ~3.08M rows): one row per VRF slot obligation observed for a
-- (chain, sender). `raw` is the observed JSON payload (JSON→JSONB).
-- No FKs by design (chain_id is a free-form value, same as `chains`).
CREATE TABLE IF NOT EXISTS vrf_obligations (
  id                            BIGSERIAL PRIMARY KEY,
  chain_id                      VARCHAR(64) NOT NULL,
  global_slot                   BIGINT NOT NULL,
  sender_pk_hash                VARCHAR(255) NOT NULL,
  sender                        VARCHAR(255),
  active_participant            BOOLEAN NOT NULL DEFAULT FALSE,
  stake                         VARCHAR(255),
  tier                          VARCHAR(32),
  threshold                     DOUBLE PRECISION,
  status                        VARCHAR(32) NOT NULL,
  produced_count                SMALLINT NOT NULL DEFAULT 0,
  out_of_window_produced_count  SMALLINT NOT NULL DEFAULT 0,
  dropped_count                 SMALLINT NOT NULL DEFAULT 0,
  evidence_run_id               VARCHAR(255),
  evidence_event_id             BIGINT,
  evidence_timestamp_ms         BIGINT,
  observed_first_seen_ms        BIGINT,
  observed_last_seen_ms         BIGINT,
  epoch                         INTEGER NOT NULL,
  epoch_slot                    INTEGER,
  slot_time_ms                  BIGINT,
  raw                           JSONB,
  synced_at                     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at                    TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ,
  vrf_output_truncated          VARCHAR(80),
  vrf_output_be_bytes           BYTEA,
  UNIQUE (chain_id, global_slot, sender_pk_hash)
);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_epoch ON vrf_obligations (chain_id, epoch);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_global_slot ON vrf_obligations (chain_id, global_slot);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_chain_status ON vrf_obligations (chain_id, status);
CREATE INDEX IF NOT EXISTS idx_vrf_obligations_sender_pk_hash ON vrf_obligations (sender_pk_hash);

-- `vrf_obligations_sync_state` — one cursor row per chain tracking how
-- far the VRF obligations sync has progressed. PK is `chain_id`
-- itself (not a surrogate id) since there is exactly one row per chain.
CREATE TABLE IF NOT EXISTS vrf_obligations_sync_state (
  chain_id                  VARCHAR(64) PRIMARY KEY,
  last_synced_slot          BIGINT NOT NULL DEFAULT 0,
  partial_window_from_slot  BIGINT,
  partial_window_to_slot    BIGINT,
  last_synced_at            TIMESTAMPTZ,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  descending_cursor_slot    BIGINT,
  last_known_tip_slot       BIGINT
);

-- `slot_outcome_reports` — mobile-client device telemetry: what
-- happened to a wallet's assigned slot, as observed on-device. There
-- is no `metric_id` column here — the source column referenced a
-- telemetry table outside this system's scope, so it was dropped.
-- `user_id` is a plain column (no FK) per spec — unlike `epoch_stats`,
-- the source never validated it against a users table either.
-- `report_uid` is the mobile client's dedup key; the unique index
-- below is the idempotency guard for re-sent reports.
CREATE TABLE IF NOT EXISTS slot_outcome_reports (
  id                          BIGSERIAL PRIMARY KEY,
  report_uid                  VARCHAR(64) NOT NULL,
  chain_id                    VARCHAR(64) NOT NULL,
  wallet_address              VARCHAR(255) NOT NULL,
  user_id                     BIGINT,
  captured_at_ms              BIGINT NOT NULL,
  global_slot                 BIGINT NOT NULL,
  epoch                       INTEGER,
  slot_in_epoch               INTEGER,
  slot_time_ms                BIGINT,
  outcome                     VARCHAR(32) NOT NULL,
  outcome_reason              VARCHAR(255),
  block_hash                  VARCHAR(255),
  block_height                BIGINT,
  canonical                   BOOLEAN,
  produced_at_ms              BIGINT,
  discarded_at_ms             BIGINT,
  node_slot_status            VARCHAR(16),
  flow_outcome                VARCHAR(64),
  flow_outcome_detail         TEXT,
  terminal_stage              VARCHAR(32),
  discard_reason              TEXT,
  empty_reason                TEXT,
  block_injected_at_ms        BIGINT,
  flow_summary_at_ms          BIGINT,
  build_ms                    INTEGER,
  db_diff_ms                  INTEGER,
  sign_ms                     INTEGER,
  inject_ms                   INTEGER,
  batch_fetch_ms              INTEGER,
  hydration_visible_ms        INTEGER,
  app_state                   VARCHAR(32),
  network_type                VARCHAR(32),
  network_connected           BOOLEAN,
  platform                    VARCHAR(32),
  platform_version            VARCHAR(255),
  app_version                 VARCHAR(255),
  app_build_number            VARCHAR(255),
  battery_level               SMALLINT,
  wakelock_held               BOOLEAN,
  foreground_service_running  BOOLEAN,
  alarm_scheduled_at_ms       BIGINT,
  alarm_fired_at_ms           BIGINT,
  monitoring_started_at_ms    BIGINT,
  created_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ,
  UNIQUE (chain_id, wallet_address, report_uid)
);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_captured_at_ms ON slot_outcome_reports (captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_epoch ON slot_outcome_reports (chain_id, epoch);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_user ON slot_outcome_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_wallet_global_slot ON slot_outcome_reports (chain_id, wallet_address, global_slot);
CREATE INDEX IF NOT EXISTS idx_slot_outcome_reports_chain_global_slot ON slot_outcome_reports (chain_id, global_slot);

-- `mobile_logs` — raw device log payloads uploaded from the mobile
-- app, keyed to the user who sent them. `payload` was JSON→JSONB.
CREATE TABLE IF NOT EXISTS mobile_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     JSONB,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mobile_logs_user ON mobile_logs (user_id);

-- `mobile_otp_codes` — email-code signup challenges for Social. Schema
-- only is migrated; ROWS ARE NOT (migrating live login codes would be
-- a security smell). Keyed by email; after identity merge, lookups go
-- through the platform's own `users.email`. No FK (rows here predate
-- any user match, by email string alone).
CREATE TABLE IF NOT EXISTS mobile_otp_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mobile_otp_codes_email ON mobile_otp_codes (email);

-- `app_version_configs` — one row per mobile OS, gating minimum /
-- recommended client build numbers. Direct carry-over from the source.
CREATE TABLE IF NOT EXISTS app_version_configs (
  id                        BIGSERIAL PRIMARY KEY,
  os                        VARCHAR(255) NOT NULL UNIQUE,
  min_build_number          INTEGER NOT NULL,
  recommended_build_number  INTEGER,
  current_version           VARCHAR(50),
  must_update_message       TEXT,
  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  should_update_message     TEXT,
  update_url                VARCHAR(500)
);
CREATE INDEX IF NOT EXISTS idx_app_version_configs_is_active ON app_version_configs (is_active);

-- `terms_versions` — one row per published terms-of-service revision.
CREATE TABLE IF NOT EXISTS terms_versions (
  id             BIGSERIAL PRIMARY KEY,
  version        VARCHAR(255) NOT NULL UNIQUE,
  title          VARCHAR(255) NOT NULL,
  body_markdown  TEXT NOT NULL,
  terms_link     VARCHAR(255),
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_terms_versions_published_at ON terms_versions (published_at);

-- `user_terms_consents` — one row per user's response to a
-- `terms_versions` row. `ip` is PII (the consent IP), classified
-- staging:private in Task 2 alongside the rest of this batch.
CREATE TABLE IF NOT EXISTS user_terms_consents (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version_id  BIGINT NOT NULL REFERENCES terms_versions(id) ON DELETE CASCADE,
  status            VARCHAR(255) NOT NULL,
  responded_at      TIMESTAMPTZ NOT NULL,
  ip                VARCHAR(45),
  app_version       VARCHAR(255),
  created_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  UNIQUE (user_id, terms_version_id)
);
-- How an acceptance was given: 'sheet' for the terms sheet's Accept button
-- (Settings → About & legal), 'continued' for carrying on past the sign-in
-- screens' "By continuing, you agree to Homeroom's terms", which the
-- first-run terms gate records (frontend/src/features/settings/
-- terms-first-run.js). NULL on rows written before the column existed.
ALTER TABLE user_terms_consents ADD COLUMN IF NOT EXISTS method VARCHAR(16);

-- `mobile_auth_tokens` — the private bearer embedded in a protocol-2 native
-- credential envelope. `token_hash` stores the sha256 hex, never the token
-- itself. The retired direct mobile login/signup surface is gone. Existing
-- unbound `session` rows are inert because authentication requires the exact
-- live native credential relation; every new token is minted inside
-- native-session-protocol's atomic exchange.
CREATE TABLE IF NOT EXISTS mobile_auth_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  ability       VARCHAR(20) NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mobile_auth_tokens_user ON mobile_auth_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_auth_tokens_id_user_uidx
  ON mobile_auth_tokens (id, user_id);
-- Retire any short-lived set-password capabilities left by the removed
-- mobile onboarding flow before narrowing the table invariant.
DELETE FROM mobile_auth_tokens WHERE ability <> 'session';
ALTER TABLE mobile_auth_tokens
  DROP CONSTRAINT IF EXISTS mobile_auth_tokens_ability_check;
ALTER TABLE mobile_auth_tokens
  ADD CONSTRAINT mobile_auth_tokens_ability_check CHECK (ability = 'session');


-- Mobile push notifications — sender identity, registrations, deliveries (#844)
--
-- This header also bounds the topochain block above for
-- tests/topochain-schema.test.js: the seven mobile_push_* tables below are
-- NOT part of the SPEC §3.4 topochain migration and must not count toward
-- its 22-table pin.

-- Database-owned sender identity and activation boundary. Same-identity sender
-- restarts retain this cutoff so queued work survives ordinary deployments.
-- Initial activation, re-enabling, and deployment identity changes establish
-- a fresh cutoff so incompatible or disabled-period work is not delivered.
CREATE TABLE IF NOT EXISTS mobile_push_deployment_state (
  environment         VARCHAR(32) PRIMARY KEY,
  firebase_project_id VARCHAR(128) NOT NULL CHECK (BTRIM(firebase_project_id) <> ''),
  send_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  send_not_before     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (BTRIM(environment) <> ''),
  CHECK (NOT send_enabled OR send_not_before IS NOT NULL)
);

-- Mobile push registrations belong to a platform user and app installation.
-- The bearer authorizes registration changes; only its expiry is copied as a
-- bounded lifetime. Provider registrations are encrypted with
-- DATA_ENCRYPTION_KEY; the hash is used only for uniqueness/rebinding and is
-- never returned or logged.
-- The installation mutation row deliberately survives logout/deletion so a
-- delayed request cannot resurrect an older registration state.
CREATE TABLE IF NOT EXISTS mobile_push_installation_mutations (
  environment              VARCHAR(32) NOT NULL,
  installation_id          UUID NOT NULL,
  latest_mutation_revision BIGINT NOT NULL CHECK (latest_mutation_revision > 0),
  latest_mutation_kind     VARCHAR(8) NOT NULL
                             CHECK (latest_mutation_kind IN ('put', 'delete')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, installation_id),
  CHECK (BTRIM(environment) <> '')
);

CREATE TABLE IF NOT EXISTS mobile_push_registrations (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  native_session_credential_reference VARCHAR(47) NOT NULL,
  environment        VARCHAR(32) NOT NULL,
  installation_id    UUID NOT NULL,
  provider           VARCHAR(16) NOT NULL DEFAULT 'fcm' CHECK (provider = 'fcm'),
  registration_hash  VARCHAR(64) NOT NULL CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
  registration_enc   TEXT NOT NULL CHECK (BTRIM(registration_enc) <> ''),
  platform           VARCHAR(16) NOT NULL CHECK (platform IN ('android', 'ios')),
  permission_status  VARCHAR(24) NOT NULL CHECK (
                         permission_status IN (
                           'authorized', 'provisional', 'denied', 'not_determined'
                         )
                       ),
  session_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment, installation_id),
  UNIQUE (environment, registration_hash),
  CHECK (BTRIM(environment) <> '')
);
ALTER TABLE mobile_push_registrations
  ADD COLUMN IF NOT EXISTS native_session_credential_reference VARCHAR(47);
-- Existing unbound registrations predate native credential authority. Cut
-- them off immediately, then reject every new unbound row. NOT VALID keeps
-- historical diagnostic rows without weakening the constraint for writes.
UPDATE mobile_push_registrations
   SET session_expires_at = LEAST(session_expires_at, NOW()),
       updated_at = NOW()
 WHERE native_session_credential_reference IS NULL
   AND session_expires_at > NOW();
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mobile_push_registrations_native_credential_required_check'
       AND conrelid = 'mobile_push_registrations'::regclass
  ) THEN
    ALTER TABLE mobile_push_registrations
      ADD CONSTRAINT mobile_push_registrations_native_credential_required_check
      CHECK (native_session_credential_reference IS NOT NULL) NOT VALID;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_mobile_push_registrations_user
  ON mobile_push_registrations (user_id, environment);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registrations_native_credential
  ON mobile_push_registrations (native_session_credential_reference)
  WHERE native_session_credential_reference IS NOT NULL;

-- Short-lived, privacy-safe registration history for support diagnostics.
-- The registration id is retained as an ordinary scalar so an event survives
-- deletion of the registration it describes. Provider tokens, ciphertext and
-- token hashes deliberately never enter this table.
CREATE TABLE IF NOT EXISTS mobile_push_registration_events (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_id   BIGINT,
  environment       VARCHAR(32) NOT NULL CHECK (BTRIM(environment) <> ''),
  installation_id   UUID NOT NULL,
  platform          VARCHAR(16) NOT NULL CHECK (platform IN ('android', 'ios')),
  permission_status VARCHAR(24) NOT NULL CHECK (
                      permission_status IN (
                        'authorized', 'provisional', 'denied', 'not_determined'
                      )
                    ),
  event_kind        VARCHAR(32) NOT NULL CHECK (event_kind IN (
                      'registration_created', 'registration_updated',
                      'token_replaced', 'registration_reassigned',
                      'client_unregistered', 'provider_invalidated',
                      'registration_corrupt', 'session_expired',
                      'firebase_project_reset'
                    )),
  reason_code       VARCHAR(96) CHECK (
                      reason_code IS NULL OR reason_code IN (
                        'client_request', 'notifications_disabled',
                        'permission_denied', 'signed_out', 'account_changed',
                        'identity_boundary', 'terminal_reset',
                        'configuration_unavailable', 'installation_reassigned',
                        'token_reassigned', 'messaging/invalid-recipient',
                        'messaging/invalid-registration-token',
                        'messaging/mismatched-credential',
                        'messaging/registration-token-not-registered',
                        'registration_decrypt_failed', 'mobile_session_expired',
                        'firebase_project_changed'
                      )
                    ),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registration_events_user
  ON mobile_push_registration_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registration_events_retention
  ON mobile_push_registration_events (created_at, id);

-- Closed notification-kind policy. The notification INSERT trigger and the
-- sender both read this table, so a future inbox kind is push-disabled until
-- it is deliberately assigned to one reviewed category here. Keep this seed
-- in lockstep with services/mobile-push-preferences.js.
CREATE TABLE IF NOT EXISTS mobile_push_kind_categories (
  kind            VARCHAR(32) PRIMARY KEY,
  category        VARCHAR(32) NOT NULL CHECK (category IN (
                    'direct_interactions', 'invitations', 'shared_work',
                    'developer_sessions', 'proposal_alerts', 'lightweight_activity',
                    'messages', 'app_alerts', 'builds', 'invite_activity'
                  )),
  default_enabled BOOLEAN NOT NULL
);
-- Existing databases already carry autogenerated category CHECK constraints;
-- CREATE TABLE IF NOT EXISTS cannot widen those. Replace the kind-category
-- constraint before inserting the new Messages rows below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_kind_categories'::regclass
       AND conname = 'mobile_push_kind_categories_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%messages%'
  ) THEN
    ALTER TABLE mobile_push_kind_categories
      DROP CONSTRAINT mobile_push_kind_categories_category_check;
    ALTER TABLE mobile_push_kind_categories
      ADD CONSTRAINT mobile_push_kind_categories_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages'
      ));
  END IF;
END $$;
-- #1374 adds the eighth category. A SECOND block rather than an edit to the
-- one above, because a database that already ran that migration would never
-- re-enter it: each block tests for the absence of its OWN newest category.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_kind_categories'::regclass
       AND conname = 'mobile_push_kind_categories_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%app_alerts%'
  ) THEN
    ALTER TABLE mobile_push_kind_categories
      DROP CONSTRAINT mobile_push_kind_categories_category_check;
    ALTER TABLE mobile_push_kind_categories
      ADD CONSTRAINT mobile_push_kind_categories_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages', 'app_alerts'
      ));
  END IF;
END $$;
-- WP-E's two categories (Your builds, Your invites), same two-block reason
-- as the ones above: this block tests for the absence of its own newest one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_kind_categories'::regclass
       AND conname = 'mobile_push_kind_categories_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%invite_activity%'
  ) THEN
    ALTER TABLE mobile_push_kind_categories
      DROP CONSTRAINT mobile_push_kind_categories_category_check;
    ALTER TABLE mobile_push_kind_categories
      ADD CONSTRAINT mobile_push_kind_categories_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages', 'app_alerts', 'builds', 'invite_activity'
      ));
  END IF;
END $$;
INSERT INTO mobile_push_kind_categories (kind, category, default_enabled) VALUES
  ('mention', 'direct_interactions', TRUE),
  -- #3952: named with @ in a request somebody filed. A mention, beside it.
  ('issue_mention', 'direct_interactions', TRUE),
  ('reply', 'direct_interactions', TRUE),
  -- #2387: a reply in an app-chat reply thread you started or joined. A
  -- direct interaction like a reply to your message, so the same category.
  ('thread_reply', 'direct_interactions', TRUE),
  -- #4535: a message in a request's discussion you filed or posted in.
  -- A reply in the same sense, so the same category beside thread_reply.
  ('issue_thread_reply', 'direct_interactions', TRUE),
  -- #2386: a friend request and its acceptance are one person reaching you
  -- directly, which is what this category already promises.
  ('friend_request', 'direct_interactions', TRUE),
  ('friend_accept', 'direct_interactions', TRUE),
  ('collab_invite', 'invitations', TRUE),
  ('collab_invite_accepted', 'invitations', TRUE),
  ('approver_invite', 'invitations', TRUE),
  ('approver_invite_accepted', 'invitations', TRUE),
  ('spec_shared', 'shared_work', TRUE),
  ('session_done', 'developer_sessions', TRUE),
  -- #3181: a dev-session turn that stopped before finishing. The other half
  -- of session_done, so the same category.
  ('session_stalled', 'developer_sessions', TRUE),
  ('auto_solve_done', 'developer_sessions', TRUE),
  ('connector_submitted', 'developer_sessions', TRUE),
  ('agent_awaiting_input', 'developer_sessions', TRUE),
  ('test_alert', 'developer_sessions', TRUE),
  ('stale_pr', 'proposal_alerts', TRUE),
  ('check_failed', 'proposal_alerts', TRUE),
  ('pr_proposed', 'proposal_alerts', TRUE),
  -- #1374's five. The three proposal-lifecycle ones join proposal_alerts;
  -- the two app ones get app_alerts. All are push-enabled by default here,
  -- which is only the SECOND gate: services/notification-preferences.js
  -- decides whether the notification is created at all, and two of these
  -- (issue_opened, pr_proposed) default off there.
  ('proposal_vote', 'proposal_alerts', TRUE),
  ('pr_merged', 'proposal_alerts', TRUE),
  ('vote_digest', 'proposal_alerts', TRUE),
  -- #1688's two: the re-confirm ask after a proposal's author pushes a new
  -- version, and the weekly "this week on <app>" card. Both are proposal
  -- lifecycle, so proposal_alerts, and both are on by default here — the
  -- per-app switch in services/notification-preferences.js is the first gate.
  ('revision_recheck', 'proposal_alerts', TRUE),
  ('weekly_digest', 'proposal_alerts', TRUE),
  -- B7: a change you can approve is ready to try. Proposal lifecycle.
  ('change_ready', 'proposal_alerts', TRUE),
  -- #4787: a change the person voted on (yes or no) went live. Proposal
  -- lifecycle, so proposal_alerts and on by default here — the per-app
  -- switch in services/notification-preferences.js (voted_changes_live) is
  -- the first gate.
  ('voted_change_merged', 'proposal_alerts', TRUE),
  ('issue_opened', 'app_alerts', TRUE),
  ('app_health', 'app_alerts', TRUE),
  -- A server-wide cap nearing its ceiling, for full admins only
  -- (services/platform-limit-alerts.js). "Something happened that affects
  -- the apps you look after", one level up, so the same category.
  ('platform_limit', 'app_alerts', TRUE),
  -- #4296: errors that should not happen, as a daily digest or one kind past
  -- its hourly line (services/platform-incident-alerts.js). Full admins
  -- only, beside platform_limit.
  ('platform_incident', 'app_alerts', TRUE),
  ('reaction', 'lightweight_activity', FALSE),
  ('kudos', 'lightweight_activity', FALSE),
  ('conversation_invite', 'messages', TRUE),
  ('conversation_message', 'messages', TRUE),
  ('conversation_mention', 'messages', TRUE),
  ('conversation_reply', 'messages', TRUE),
  ('conversation_reaction', 'messages', TRUE),
  -- #2387: a reply in a conversation thread you started or replied in.
  ('conversation_thread_reply', 'messages', TRUE),
  -- A person's message in a small private group's discussion
  -- (services/group-channel-notify.js): the group's chat, so Messages.
  ('channel_message', 'messages', TRUE),
  -- WP-E: the Homeroom bot's moments about something you asked it for
  -- (services/homeroom-bot-dm.js BUILD_KINDS), so turning Messages off does
  -- not silence "it's ready to try".
  ('build_ready', 'builds', TRUE),
  ('build_needs_you', 'builds', TRUE),
  ('build_stopped', 'builds', TRUE),
  ('build_live', 'builds', TRUE),
  -- WP-E: the people your invite links bring (services/invite-activity.js).
  ('invite_opened', 'invite_activity', TRUE),
  ('member_joined', 'invite_activity', TRUE),
  ('first_message', 'invite_activity', TRUE)
ON CONFLICT (kind) DO UPDATE
  SET category = EXCLUDED.category,
      default_enabled = EXCLUDED.default_enabled;
DELETE FROM mobile_push_kind_categories
 WHERE kind NOT IN (
   'mention', 'issue_mention', 'reply', 'thread_reply', 'issue_thread_reply',
   'collab_invite', 'collab_invite_accepted',
   'approver_invite', 'approver_invite_accepted', 'spec_shared',
   'session_done', 'test_alert', 'auto_solve_done', 'stale_pr', 'check_failed',
   'pr_proposed', 'reaction', 'kudos',
   -- These two are INSERTed above but were missing from this list, so every
   -- boot seeded them and then deleted them again: push-disabled in the
   -- database while services/mobile-push-preferences.js said otherwise.
   -- Restored here rather than left for a separate change, because the list
   -- had to be edited anyway and leaving two silently-broken kinds beside
   -- five new ones is how the next person concludes the pattern is fine.
   'connector_submitted', 'agent_awaiting_input',
   -- #1374's five.
   'proposal_vote', 'pr_merged', 'vote_digest', 'issue_opened', 'app_health',
   -- #1688's two.
   'revision_recheck', 'weekly_digest',
   -- B7.
   'change_ready',
   -- #4787.
   'voted_change_merged',
   'conversation_invite', 'conversation_message', 'conversation_mention',
   'conversation_reply', 'conversation_reaction',
   -- #2386's two.
   'friend_request', 'friend_accept',
   -- #2387.
   'conversation_thread_reply',
   -- A small private group's discussion.
   'channel_message',
   -- #3181.
   'session_stalled',
   -- Server-wide limit alerts for full admins.
   'platform_limit',
   -- #4296: the unexpected events digest and hourly alert, same audience.
   'platform_incident',
   -- WP-E.
   'build_ready', 'build_needs_you', 'build_stopped', 'build_live',
   'invite_opened', 'member_joined', 'first_message'
 );

-- Sparse account overrides. The closed policy above supplies defaults, so
-- existing accounts need no backfill and a preference change never touches
-- per-device Firebase registrations.
CREATE TABLE IF NOT EXISTS mobile_push_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   VARCHAR(32) NOT NULL CHECK (category IN (
               'direct_interactions', 'invitations', 'shared_work',
               'developer_sessions', 'proposal_alerts', 'lightweight_activity',
               'messages', 'app_alerts', 'builds', 'invite_activity'
             )),
  enabled    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_preferences'::regclass
       AND conname = 'mobile_push_preferences_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%messages%'
  ) THEN
    ALTER TABLE mobile_push_preferences
      DROP CONSTRAINT mobile_push_preferences_category_check;
    ALTER TABLE mobile_push_preferences
      ADD CONSTRAINT mobile_push_preferences_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages'
      ));
  END IF;
END $$;
-- #1374's eighth category, same two-block reason as the one above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_preferences'::regclass
       AND conname = 'mobile_push_preferences_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%app_alerts%'
  ) THEN
    ALTER TABLE mobile_push_preferences
      DROP CONSTRAINT mobile_push_preferences_category_check;
    ALTER TABLE mobile_push_preferences
      ADD CONSTRAINT mobile_push_preferences_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages', 'app_alerts'
      ));
  END IF;
END $$;
-- WP-E's two categories (Your builds, Your invites), same two-block reason
-- as the ones above: this block tests for the absence of its own newest one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mobile_push_preferences'::regclass
       AND conname = 'mobile_push_preferences_category_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%invite_activity%'
  ) THEN
    ALTER TABLE mobile_push_preferences
      DROP CONSTRAINT mobile_push_preferences_category_check;
    ALTER TABLE mobile_push_preferences
      ADD CONSTRAINT mobile_push_preferences_category_check
      CHECK (category IN (
        'direct_interactions', 'invitations', 'shared_work',
        'developer_sessions', 'proposal_alerts', 'lightweight_activity',
        'messages', 'app_alerts', 'builds', 'invite_activity'
      ));
  END IF;
END $$;

-- Per-app notification preferences (#1374). The sibling of the table above,
-- and deliberately a separate one: mobile_push_preferences answers "may this
-- ping my phone" and runs AFTER a notification exists, while this answers
-- "do I get this at all, for this app" and gates whether the notification is
-- created. Because mobile_push_deliveries below references notifications(id),
-- suppressing the row suppresses the push with it, which is the one-switch
-- behaviour the request asked for and is why the two cannot drift apart.
--
-- `app_id` is NULLABLE and that is the point: a row with app_id IS NULL is
-- the account-wide default for every app, and a row with an app_id overrides
-- it for that app alone. Resolution is per-app, then account, then the
-- category's own default (services/notification-preferences.js).
--
-- NO CHECK constraint on `category`, unlike the table above. That one needed
-- a hand-written DO block to migrate its constraint the first time a category
-- was added, and this list is expected to grow with each new notification
-- kind. The catalogue in services/notification-preferences.js is the
-- authority and validatePreferencePatch refuses an unknown key before any
-- write, so the constraint would buy a migration chore rather than a
-- guarantee.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id     INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  category   VARCHAR(32) NOT NULL,
  enabled    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The natural key, expressed through COALESCE because a NULLABLE column
-- cannot carry it: NULLs are not equal to each other, so a plain UNIQUE
-- (user_id, app_id, category) would happily admit two account-wide rows for
-- the same category. 0 is safe as the sentinel — apps.id is a SERIAL and
-- never takes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_key
  ON notification_preferences (user_id, COALESCE(app_id, 0), category);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_lookup
  ON notification_preferences (category, user_id);
-- A person's own notification choices, and the apps they care enough about
-- to mute. Never cloned into staging.
COMMENT ON TABLE notification_preferences IS 'staging:private';

-- Durable notification outbox. No provider token is copied here. `attempts`
-- tracks retry backoff within the single Social sender.
CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
  id                BIGSERIAL PRIMARY KEY,
  notification_id   INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  registration_id   BIGINT REFERENCES mobile_push_registrations(id) ON DELETE SET NULL,
  environment       VARCHAR(32) NOT NULL CHECK (BTRIM(environment) <> ''),
  installation_id   UUID NOT NULL,
  -- Snapshot the destination platform so a provider-invalidated registration
  -- can be deleted without turning its durable diagnostic row into "unknown".
  platform          VARCHAR(16) CHECK (platform IN ('android', 'ios')),
  status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sending', 'sent', 'dead', 'cancelled')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  sent_at           TIMESTAMPTZ,
  last_error_code   VARCHAR(96),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, environment, installation_id)
);
ALTER TABLE mobile_push_deliveries
  ADD COLUMN IF NOT EXISTS platform VARCHAR(16);
UPDATE mobile_push_deliveries delivery
   SET platform = registration.platform
  FROM mobile_push_registrations registration
 WHERE delivery.registration_id = registration.id
   AND delivery.platform IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mobile_push_deliveries_platform_check'
       AND conrelid = 'mobile_push_deliveries'::regclass
  ) THEN
    ALTER TABLE mobile_push_deliveries
      ADD CONSTRAINT mobile_push_deliveries_platform_check
      CHECK (platform IN ('android', 'ios')) NOT VALID;
  END IF;
END $$;
ALTER TABLE mobile_push_deliveries
  VALIDATE CONSTRAINT mobile_push_deliveries_platform_check;
CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_claim
  ON mobile_push_deliveries (environment, available_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_registration
  ON mobile_push_deliveries (registration_id) WHERE registration_id IS NOT NULL;

COMMENT ON TABLE mobile_push_deployment_state IS 'staging:private';
COMMENT ON TABLE mobile_push_installation_mutations IS 'staging:private';
COMMENT ON TABLE mobile_push_registrations IS 'staging:private';
COMMENT ON TABLE mobile_push_registration_events IS 'staging:private';
COMMENT ON TABLE mobile_push_deliveries IS 'staging:private';

-- Personal app blocks affect one viewer, never the app's contributors.
CREATE TABLE IF NOT EXISTS user_app_blocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_user_app_blocks_app ON user_app_blocks (app_id, user_id);
COMMENT ON TABLE user_app_blocks IS 'staging:private';

-- Capture the push outbox in the same transaction as the canonical
-- notification. The kind/category registry is intentionally closed: adding a
-- new inbox kind does not automatically make it a lock-screen event.
CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.read_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = NEW.user_id AND b.app_id = NEW.app_id)
     OR NOT COALESCE((
       SELECT COALESCE(preference.enabled, policy.default_enabled)
         FROM mobile_push_kind_categories policy
         LEFT JOIN mobile_push_preferences preference
           ON preference.user_id = NEW.user_id
          AND preference.category = policy.category
        WHERE policy.kind = NEW.kind
     ), FALSE) THEN
    RETURN NEW;
  END IF;

  -- Project changes lock deployment state before deleting registrations.
  -- Take the same lock order here so outbox capture cannot deadlock with that
  -- transition or commit an old-project registration behind it.
  PERFORM environment
    FROM mobile_push_deployment_state
   ORDER BY environment
   FOR KEY SHARE;

  WITH eligible AS MATERIALIZED (
    SELECT r.id, r.environment, r.installation_id, r.platform
      FROM mobile_push_registrations r
      JOIN mobile_push_deployment_state s ON s.environment = r.environment
     WHERE r.user_id = NEW.user_id
       AND r.session_expires_at > NOW()
       AND r.permission_status IN ('authorized', 'provisional')
       AND s.send_enabled
       AND s.send_not_before IS NOT NULL
       AND COALESCE(NEW.created_at, NOW()) >= s.send_not_before
     ORDER BY r.id
     FOR KEY SHARE OF r
  )
  INSERT INTO mobile_push_deliveries (
    notification_id, registration_id, environment, installation_id, platform, expires_at, available_at
  )
  SELECT NEW.id, id, environment, installation_id, platform,
         COALESCE(NEW.created_at, NOW()) + INTERVAL '24 hours',
         NOW() + CASE WHEN NEW.kind = 'test_alert' THEN INTERVAL '10 seconds' ELSE INTERVAL '0 seconds' END
    FROM eligible
  ON CONFLICT (notification_id, environment, installation_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'notifications_enqueue_mobile_push_deliveries'
       AND tgrelid = 'notifications'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER notifications_enqueue_mobile_push_deliveries
      AFTER INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION enqueue_mobile_push_deliveries();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Topochain Task 2 — `users` columns, `platform_settings` seed, staging
-- privacy (plan Task 2; SPEC §8.5 users columns 3283-3294, §3.5 settings
-- 801-804, §6 staging privacy 3080-3088).
-- ═══════════════════════════════════════════════════════════════════════

-- Columns the topochain merge adds to the platform's existing `users`
-- table — SPEC §8.5 says plainly "the platform users table IS the users
-- table"; there is no separate topochain users table. Every new column
-- is nullable or safely defaulted so this whole block is a no-op for
-- every pre-existing platform account. `email` gets a PARTIAL unique
-- index below (WHERE email IS NOT NULL) because existing platform users
-- have none. `users.password` is already tagged staging:private near
-- schema.sql:1148 — not re-tagged here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email                      VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmation_token   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmation_sent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_confirmed_at         TIMESTAMPTZ;
-- WP-E: whether activity mail may reach this person when no phone can take
-- the push it stands in for (services/activity-mail.js). The unsubscribe link
-- in every one of those emails clears it (routes/activity-mail.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_email BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name               VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram                   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord                    VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github                     VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS x                          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_in_waitlist             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_submitted_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_ip                VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS waitlist_answers           JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer                   VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer_handle            VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS country                    VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS city                       VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_info                JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS exclude_podium             BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accept_logs                BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at                 TIMESTAMPTZ;

-- Email uniqueness is case-insensitive (issue #1269): login, the admin
-- editor and the password-reset request all match on lower(email), so
-- uniqueness must hold on lower(email) too or two case-variants of one
-- address would each satisfy a raw-column index while colliding at
-- lookup time. The DO block (1) lower-cases any legacy mixed-case rows,
-- skipping — with a warning, never a boot failure — any row whose
-- lowered form already exists on another row (production has zero
-- mixed-case emails, but a self-hosted instance must not crash-loop over
-- one); (2) creates users_email_lower_unique, downgrading a residual
-- case-variant collision to a warning; (3) drops the old raw-column
-- users_email_unique only once the functional index exists, so email
-- uniqueness is never left unenforced. Every write path stores emails
-- lower-cased, so the skip branches are legacy-data-only.
DO $$
BEGIN
  UPDATE users u SET email = lower(u.email)
   WHERE u.email IS NOT NULL AND u.email <> lower(u.email)
     AND NOT EXISTS (
       SELECT 1 FROM users o
        WHERE o.id <> u.id AND lower(o.email) = lower(u.email)
     );
  IF EXISTS (
    SELECT 1 FROM users u WHERE u.email IS NOT NULL AND u.email <> lower(u.email)
  ) THEN
    RAISE WARNING 'users: case-variant duplicate emails left unnormalized; resolve them manually so users_email_lower_unique can be created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_email_lower_unique'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX users_email_lower_unique ON users(lower(email)) WHERE email IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'users_email_lower_unique not created: case-variant duplicate emails exist; the raw-column users_email_unique index is kept';
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_email_lower_unique'
  ) THEN
    DROP INDEX IF EXISTS users_email_unique;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_is_in_waitlist ON users(is_in_waitlist);
CREATE INDEX IF NOT EXISTS idx_users_exclude_podium ON users(exclude_podium);
CREATE INDEX IF NOT EXISTS idx_users_email_confirmation_token ON users(email_confirmation_token);
CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram);
CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord);
CREATE INDEX IF NOT EXISTS idx_users_country ON users(country);

-- The user directory's handle match (services/user-directory.js, #1213).
-- Every lookup runs `LOWER(username) = LOWER($1)` and every typeahead
-- keystroke runs `LOWER(username) LIKE '<prefix>%' ... ORDER BY
-- LOWER(username)`, across three surfaces (app-platform API, the shell's
-- bridge relay, the collaborator-invite typeahead) — without these both
-- were sequential scans. Two indexes because they serve different
-- operators: the default (btree/collation) opclass answers the equality
-- and the ORDER BY, but under a non-C collation it cannot serve LIKE
-- prefix ranges — that needs text_pattern_ops, which in turn cannot serve
-- the collation-ordered ORDER BY.
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern ON users (LOWER(username) text_pattern_ops);

-- `platform_settings` gains a `description` column (SPEC §3.5) and the
-- topochain point-values as `topochain_`-prefixed keys, so the prefix can
-- never collide with a platform key. Seeded with ON CONFLICT (key) DO
-- NOTHING so an operator's later edit (admin settings screen) survives
-- every reboot.
--
-- NOTE on key count (task-2 brief resolution of a SPEC ambiguity): SPEC
-- §3.5's prose says "the seven topochain values", but the reset-defaults
-- table it points readers at (§4.9 POST /point-settings/reset, SPEC
-- 2825-2840) lists only SIX keys (first_block, produced_half_blocks,
-- top_1, top_2, top_3, success_50_percent). The task-2 brief resolves
-- the count by naming seven keys explicitly — those six plus
-- `inviting_new_participant_points` — and that concrete list is what's
-- seeded below verbatim. `bug_report_points` and
-- `community_contribution_points` are NOT settings keys: they are
-- per-row columns already on `leaderboard_snapshots` (Task 1), scored
-- per activity rather than configured as a flat point value.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS description TEXT;
INSERT INTO platform_settings (key, value, description) VALUES
  ('topochain_first_block_points',              '250',
    'Points awarded for producing a season event''s first block.'),
  ('topochain_produced_half_blocks_points',     '0',
    'Points awarded for producing at least half of the expected blocks.'),
  ('topochain_top_1_points',                    '1500',
    'Points awarded for finishing rank 1 on the leaderboard.'),
  ('topochain_top_2_points',                    '1000',
    'Points awarded for finishing rank 2 on the leaderboard.'),
  ('topochain_top_3_points',                    '500',
    'Points awarded for finishing rank 3 on the leaderboard.'),
  ('topochain_success_50_percent_points',       '1000',
    'Points awarded for a block-production success rate of at least 50%.'),
  ('topochain_inviting_new_participant_points', '0',
    'Points awarded for inviting a new participant into the competition.')
ON CONFLICT (key) DO NOTHING;

-- Staging privacy (SPEC §6), table-level: every row of these tables is
-- sensitive in its entirety in a staging clone (truncated by
-- db-manager.js's truncatePrivateTables — discovered dynamically via
-- these COMMENTs, no code change needed there). `mobile_otp_codes` and
-- `mobile_auth_tokens` are additionally hidden from the prod-debug role
-- entirely (see DENIED_TABLES in src/services/debug-access.js).
COMMENT ON TABLE token_allocation     IS 'staging:private';
COMMENT ON TABLE chains               IS 'staging:private';
COMMENT ON TABLE vrf_obligations      IS 'staging:private';
COMMENT ON TABLE slot_outcome_reports IS 'staging:private';
COMMENT ON TABLE mobile_logs          IS 'staging:private';
COMMENT ON TABLE mobile_otp_codes     IS 'staging:private';
COMMENT ON TABLE mobile_auth_tokens   IS 'staging:private';
COMMENT ON TABLE user_terms_consents  IS 'staging:private'; -- contains consent IPs, SPEC 781-799

-- Staging privacy (SPEC §6), column-level: the row survives cloning (FK-
-- targeted attribution keeps working) but the credential/PII-bearing
-- value is scrubbed. All four are additionally hidden from the
-- prod-debug role by column (DENIED_COLUMNS in
-- src/services/debug-access.js) so a future secret column on either
-- table fails closed rather than leaking.
COMMENT ON COLUMN users.email_confirmation_token    IS 'staging:private';
COMMENT ON COLUMN users.waitlist_ip                 IS 'staging:private';
COMMENT ON COLUMN onchain_accounts.secret_key        IS 'staging:private';
COMMENT ON COLUMN onchain_accounts.registration_code IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Topochain Task 8 — mobile auth / shared web signup: users.password_set
-- (plan Task 8;
-- Global Constraints #4/#6, task-8 brief).
-- ═══════════════════════════════════════════════════════════════════════

-- Every platform `users` row already has a NOT NULL `password` (a real
-- bcrypt hash) — but the shared web OTP flow
-- (POST /api/auth/otp/verify) can create a user row with NO
-- caller-chosen password at all: it stores a random, unusable bcrypt hash
-- (of 32 random bytes nobody knows) just to satisfy the NOT NULL
-- constraint. `password_set` is how the platform auth surface tells "a real,
-- caller-chosen password exists" apart from "some syntactically-valid
-- hash nobody can ever produce" — POST /auth/check-email's
-- `password_set` response field and POST /auth/login's guest/member/
-- operator level computation both branch on it directly (auth.js).
-- Existing platform users (registered the normal way, always with a real
-- chosen password) default TRUE via DEFAULT TRUE, so this column is a
-- no-op for every pre-existing account; only the OTP-created path (and,
-- until it completes set-password, that path alone) ever sets it FALSE.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════════════════
-- Native session establish protocol 2. The web incarnation is created lazily
-- on the first ticket request and attached to exactly one live cookie session.
-- Its row deliberately survives deletion/expiry of that session: an exchange
-- can prove that the exact session is no longer live, while an already-issued
-- native credential retains an auditable origin until explicit revocation.
CREATE TABLE IF NOT EXISTS native_session_web_incarnations (
  id          VARCHAR(47) PRIMARY KEY
    CHECK (id ~ '^nsw_[A-Za-z0-9_-]{43}$'),
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, user_id)
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native_session_incarnation_id
  VARCHAR(47);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sessions'::regclass
       AND conname = 'sessions_native_session_incarnation_user_fkey'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_native_session_incarnation_user_fkey
      FOREIGN KEY (native_session_incarnation_id, user_id)
      REFERENCES native_session_web_incarnations(id, user_id)
      ON DELETE SET NULL (native_session_incarnation_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_session_incarnation_uidx
  ON sessions (native_session_incarnation_id)
  WHERE native_session_incarnation_id IS NOT NULL;

-- A caller chooses only the opaque attempt id and the sole protocol-2 target,
-- `running`. Subject and network are server-derived and frozen here. Reusing
-- an attempt id with any changed semantic input is a sticky conflict.
CREATE TABLE IF NOT EXISTS native_session_attempts (
  attempt_id                 VARCHAR(47) PRIMARY KEY
    CHECK (attempt_id ~ '^nsa_[A-Za-z0-9_-]{43}$'),
  protocol                   SMALLINT NOT NULL DEFAULT 2 CHECK (protocol = 2),
  user_id                    BIGINT NOT NULL,
  web_session_incarnation_id VARCHAR(47) NOT NULL,
  desired_runtime            VARCHAR(16) NOT NULL CHECK (desired_runtime = 'running'),
  network_id                 VARCHAR(16) NOT NULL CHECK (network_id = 'testnet'),
  chain_id                   VARCHAR(100) NOT NULL
    CHECK (chain_id ~ '^utc1[023456789acdefghjklmnpqrstuvwxyz]+$'),
  request_digest             CHAR(64) NOT NULL
    CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  walletless_supported       BOOLEAN NOT NULL DEFAULT FALSE,
  state                      VARCHAR(16) NOT NULL DEFAULT 'ticketed'
    CHECK (state IN ('ticketed', 'exchanged', 'revoked')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_id, user_id, web_session_incarnation_id, network_id, chain_id),
  FOREIGN KEY (web_session_incarnation_id, user_id)
    REFERENCES native_session_web_incarnations(id, user_id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at)
);
-- TODO(remove-build-1250-compat): Drop decoder negotiation when all supported
-- mobile builds accept account:null. Existing attempts keep the safe fallback.
ALTER TABLE native_session_attempts
  ADD COLUMN IF NOT EXISTS walletless_supported BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS native_session_attempts_user_idx
  ON native_session_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS native_session_attempts_incarnation_idx
  ON native_session_attempts (web_session_incarnation_id, state);

-- The browser may mint only this short-lived, attempt-bound handoff. Its raw
-- value lives in a path-scoped HttpOnly cookie and is never returned to
-- JavaScript; native code reads the WebView cookie store and echoes the value
-- in a purpose-specific header to redeem the exact ticket. Repeated delivery
-- of one redemption is an idempotent retry of the same logical use.
CREATE TABLE IF NOT EXISTS native_session_handoffs (
  attempt_id    VARCHAR(47) PRIMARY KEY
    REFERENCES native_session_attempts(attempt_id) ON DELETE CASCADE,
  handoff_hash  CHAR(64) NOT NULL UNIQUE
    CHECK (handoff_hash ~ '^[0-9a-f]{64}$'),
  issued_at     TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  redeemed_at   TIMESTAMPTZ,
  CHECK (expires_at = issued_at + INTERVAL '5 minutes'),
  CHECK (redeemed_at IS NULL OR redeemed_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS native_session_handoffs_expiry_idx
  ON native_session_handoffs (expires_at);

-- Raw tickets never reach storage. Their SHA-256 digest is the lookup key;
-- the one successful JSON response is encrypted at rest so ticket issuance
-- can replay the byte-identical body without minting a second capability.
CREATE TABLE IF NOT EXISTS native_session_tickets (
  id                 BIGSERIAL PRIMARY KEY,
  attempt_id         VARCHAR(47) NOT NULL UNIQUE
    REFERENCES native_session_attempts(attempt_id) ON DELETE CASCADE,
  ticket_hash        CHAR(64) NOT NULL UNIQUE
    CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  exchange_challenge CHAR(43) NOT NULL
    CHECK (exchange_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  audience           VARCHAR(64) NOT NULL
    CHECK (audience = 'usernode-native-session-v2'),
  encrypted_response TEXT NOT NULL,
  response_digest    CHAR(64) NOT NULL
    CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  state              VARCHAR(16) NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'exchanged', 'revoked')),
  issued_at          TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  CHECK (expires_at = issued_at + INTERVAL '5 minutes')
);
CREATE INDEX IF NOT EXISTS native_session_tickets_expiry_idx
  ON native_session_tickets (expires_at) WHERE state = 'issued';

-- Installation identity is app/device continuity-only in protocol 2, not
-- user identity or hardware attestation. The caller submits public JWKs; the
-- server validates them and derives the purpose-specific ids and RFC 7638
-- thumbprints stored here. Authenticated attempts and credentials, not this
-- stable installation row, carry the exact user binding.
CREATE TABLE IF NOT EXISTS native_installation_key_generations (
  installation_id                 VARCHAR(47) NOT NULL
    CHECK (installation_id ~ '^nsi_[A-Za-z0-9_-]{43}$'),
  key_generation                  INTEGER NOT NULL CHECK (key_generation = 1),
  possession_key_id               VARCHAR(48) NOT NULL UNIQUE
    CHECK (possession_key_id ~ '^nskp_[A-Za-z0-9_-]{43}$'),
  possession_key_thumbprint       CHAR(43) NOT NULL
    CHECK (possession_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  possession_public_jwk           JSONB NOT NULL,
  envelope_key_id                 VARCHAR(48) NOT NULL UNIQUE
    CHECK (envelope_key_id ~ '^nske_[A-Za-z0-9_-]{43}$'),
  envelope_key_thumbprint         CHAR(43) NOT NULL
    CHECK (envelope_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  envelope_public_jwk             JSONB NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (installation_id, key_generation),
  UNIQUE (installation_id),
  UNIQUE (possession_key_thumbprint),
  UNIQUE (envelope_key_thumbprint),
  CHECK (jsonb_typeof(possession_public_jwk) = 'object'),
  CHECK (jsonb_typeof(envelope_public_jwk) = 'object')
);

-- A credential always references the existing mobile bearer and may reference
-- a provisioned wallet. The encrypted compact JWE in the sibling table is the
-- only response carrying either secret to the native key owner.
CREATE TABLE IF NOT EXISTS native_session_credentials (
  credential_reference       VARCHAR(47) PRIMARY KEY
    CHECK (credential_reference ~ '^nsc_[A-Za-z0-9_-]{43}$'),
  credential_generation      INTEGER NOT NULL DEFAULT 1 CHECK (credential_generation = 1),
  attempt_id                 VARCHAR(47) NOT NULL UNIQUE,
  user_id                    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  web_session_incarnation_id VARCHAR(47) NOT NULL,
  installation_id            VARCHAR(47) NOT NULL,
  installation_key_generation INTEGER NOT NULL,
  mobile_auth_token_id       BIGINT UNIQUE,
  account_id                 BIGINT,
  network_id                 VARCHAR(16) NOT NULL CHECK (network_id = 'testnet'),
  chain_id                   VARCHAR(100) NOT NULL,
  exchange_request_digest    CHAR(64) NOT NULL
    CHECK (exchange_request_digest ~ '^[0-9a-f]{64}$'),
  state                      VARCHAR(16) NOT NULL DEFAULT 'valid'
    CHECK (state IN ('valid', 'revoked')),
  revocation_reason          VARCHAR(32)
    CONSTRAINT native_session_credentials_revocation_reason_closed_check
      CHECK (revocation_reason IN ('web_logout', 'account_recovery')),
  revoked_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (attempt_id, user_id, web_session_incarnation_id, network_id, chain_id)
    REFERENCES native_session_attempts(
      attempt_id, user_id, web_session_incarnation_id, network_id, chain_id
    ),
  FOREIGN KEY (installation_id, installation_key_generation)
    REFERENCES native_installation_key_generations(installation_id, key_generation),
  FOREIGN KEY (mobile_auth_token_id, user_id)
    REFERENCES mobile_auth_tokens(id, user_id)
    ON DELETE SET NULL (mobile_auth_token_id),
  FOREIGN KEY (account_id, user_id)
    REFERENCES onchain_accounts(id, user_id) ON DELETE RESTRICT,
  CHECK ((state = 'valid' AND revoked_at IS NULL AND revocation_reason IS NULL)
      OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
  CONSTRAINT native_session_credentials_expiry_order_check
    CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- A restored web session is authority only while this exact native lease is
-- live. Keep the incarnation too, for exact attempt replay and web logout.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native_session_credential_reference
  VARCHAR(47) REFERENCES native_session_credentials(credential_reference) ON DELETE CASCADE;

-- Existing databases received an unnamed auto-generated CHECK that also
-- admitted the retired `mobile_logout` value. Replace it without rewriting
-- revoked audit history. `NOT VALID` still rejects that value on every new or
-- updated row; operators may validate after confirming historical rows are
-- already within the closed set. Fresh databases create the validated named
-- constraint above and skip this compatibility branch.
ALTER TABLE native_session_credentials
  DROP CONSTRAINT IF EXISTS native_session_credentials_revocation_reason_check;
-- Login, settings, and push do not require a provisioned on-chain account.
-- Existing wallet-backed rows retain their exact account/user foreign key.
ALTER TABLE native_session_credentials
  ALTER COLUMN account_id DROP NOT NULL;
-- Sliding mobile leases may move beyond their initial 90-day bound. Replace
-- the old unnamed exact-expiry constraint while retaining the database-owned
-- requirement that every lease ends after credential creation.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'native_session_credentials'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%expires_at = (created_at +%90 days%'
  LOOP
    EXECUTE format(
      'ALTER TABLE native_session_credentials DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'native_session_credentials_expiry_order_check'
       AND conrelid = 'native_session_credentials'::regclass
  ) THEN
    ALTER TABLE native_session_credentials
      ADD CONSTRAINT native_session_credentials_expiry_order_check
      CHECK (expires_at > created_at);
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'native_session_credentials_revocation_reason_closed_check'
       AND conrelid = 'native_session_credentials'::regclass
  ) THEN
    ALTER TABLE native_session_credentials
      ADD CONSTRAINT native_session_credentials_revocation_reason_closed_check
      CHECK (revocation_reason IN ('web_logout', 'account_recovery')) NOT VALID;
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS native_session_credentials_reference_user_uidx
  ON native_session_credentials (credential_reference, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS native_session_credentials_policy_binding_uidx
  ON native_session_credentials (
    credential_reference, credential_generation, user_id, account_id,
    network_id, chain_id
  );
-- Replace the earlier reference-only draft constraint, if this uncommitted
-- migration was exercised locally, with the final exact subject binding.
ALTER TABLE mobile_push_registrations
  DROP CONSTRAINT IF EXISTS mobile_push_registrations_native_credential_fk;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mobile_push_registrations_native_credential_user_fk'
       AND conrelid = 'mobile_push_registrations'::regclass
  ) THEN
    ALTER TABLE mobile_push_registrations
      ADD CONSTRAINT mobile_push_registrations_native_credential_user_fk
      FOREIGN KEY (native_session_credential_reference, user_id)
      REFERENCES native_session_credentials(credential_reference, user_id)
      ON DELETE CASCADE;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS native_session_credentials_user_idx
  ON native_session_credentials (user_id, state);
CREATE INDEX IF NOT EXISTS native_session_credentials_incarnation_idx
  ON native_session_credentials (web_session_incarnation_id, state);

CREATE TABLE IF NOT EXISTS native_session_credential_envelopes (
  credential_reference VARCHAR(47) PRIMARY KEY
    REFERENCES native_session_credentials(credential_reference) ON DELETE CASCADE,
  compact_jwe           TEXT NOT NULL
    CHECK (compact_jwe ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  compact_jwe_digest    CHAR(64) NOT NULL
    CHECK (compact_jwe_digest ~ '^[0-9a-f]{64}$'),
  encrypted_response    TEXT NOT NULL,
  response_digest       CHAR(64) NOT NULL
    CHECK (response_digest ~ '^[0-9a-f]{64}$'),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Epoch-scoped native delegation policy replaces timestamp delegation at one
-- immutable per-chain cutover epoch. A one-shot operator transaction records
-- that C, closes the old open periods at C's supplied timestamp, and inserts
-- the verified active inventory as `cutover` rows effective exactly at C.
-- Subsequent credential-bound `native` requests accepted in E are E+2.
--
-- The per-chain fence linearizes direct canonical `/status` samples without
-- holding a database transaction across the HTTP call. Once an E+1 sample
-- advances `observed_epoch`, an older E sample is stale and cannot append an
-- E+2 change. The policy's global BIGSERIAL id is both its public monotonic
-- revision and the same-epoch last-write-wins order.
CREATE TABLE IF NOT EXISTS native_epoch_delegation_fences (
  network_id          VARCHAR(16) NOT NULL CHECK (network_id = 'testnet'),
  chain_id            VARCHAR(100) NOT NULL
    CHECK (chain_id ~ '^utc1[023456789acdefghjklmnpqrstuvwxyz]+$'),
  observed_epoch      BIGINT NOT NULL
    CHECK (observed_epoch BETWEEN 0 AND 4294967295),
  cutover_epoch       BIGINT
    CHECK (cutover_epoch BETWEEN 0 AND 4294967295),
  cutover_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((cutover_epoch IS NULL) = (cutover_at IS NULL)),
  PRIMARY KEY (network_id, chain_id)
);

CREATE TABLE IF NOT EXISTS native_epoch_delegation_policies (
  id                    BIGSERIAL PRIMARY KEY CHECK (id > 0),
  request_id            VARCHAR(47) NOT NULL
    CHECK (request_id ~ '^nd[bp]_[A-Za-z0-9_-]{43}$'),
  source                VARCHAR(16) NOT NULL DEFAULT 'native'
    CHECK (source IN ('native', 'cutover')),
  credential_reference  VARCHAR(47)
    CHECK (credential_reference ~ '^nsc_[A-Za-z0-9_-]{43}$'),
  credential_generation INTEGER CHECK (credential_generation = 1),
  user_id               BIGINT NOT NULL CHECK (user_id > 0),
  account_id            BIGINT NOT NULL CHECK (account_id > 0),
  account_address       VARCHAR(255) NOT NULL
    CHECK (account_address <> '' AND account_address = BTRIM(account_address)),
  network_id            VARCHAR(16) NOT NULL CHECK (network_id = 'testnet'),
  chain_id              VARCHAR(100) NOT NULL,
  delegated             BOOLEAN NOT NULL,
  changed               BOOLEAN NOT NULL,
  accepted_epoch        BIGINT NOT NULL
    CHECK (accepted_epoch BETWEEN 0 AND 4294967293),
  effective_epoch       BIGINT NOT NULL
    CHECK (effective_epoch BETWEEN 2 AND 4294967295),
  accepted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id),
  FOREIGN KEY (network_id, chain_id)
    REFERENCES native_epoch_delegation_fences(network_id, chain_id),
  CONSTRAINT native_epoch_delegation_policies_source_fields_check CHECK (
    (source = 'native'
      AND request_id ~ '^ndp_[A-Za-z0-9_-]{43}$'
      AND credential_reference IS NOT NULL
      AND credential_generation = 1
      AND effective_epoch = accepted_epoch + 2)
    OR
    (source = 'cutover'
      AND request_id ~ '^ndb_[A-Za-z0-9_-]{43}$'
      AND credential_reference IS NULL
      AND credential_generation IS NULL
      AND effective_epoch = accepted_epoch)
  )
);
CREATE INDEX IF NOT EXISTS native_epoch_delegation_policy_account_idx
  ON native_epoch_delegation_policies (
    network_id, chain_id, account_address, effective_epoch DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS native_epoch_delegation_policy_effective_idx
  ON native_epoch_delegation_policies (
    network_id, chain_id, effective_epoch DESC, id DESC
  );

-- Idempotent upgrades for databases that received the additive pre-cutover
-- schema. The old constraints admitted only ndp_/credential/E+2 rows.
ALTER TABLE native_epoch_delegation_fences
  ADD COLUMN IF NOT EXISTS cutover_epoch BIGINT;
ALTER TABLE native_epoch_delegation_fences
  ADD COLUMN IF NOT EXISTS cutover_at TIMESTAMPTZ;
ALTER TABLE native_epoch_delegation_fences
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_fences_cutover_epoch_check;
ALTER TABLE native_epoch_delegation_fences
  ADD CONSTRAINT native_epoch_delegation_fences_cutover_epoch_check
    CHECK (cutover_epoch BETWEEN 0 AND 4294967295);
ALTER TABLE native_epoch_delegation_fences
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_fences_check;
ALTER TABLE native_epoch_delegation_fences
  ADD CONSTRAINT native_epoch_delegation_fences_check
    CHECK ((cutover_epoch IS NULL) = (cutover_at IS NULL));

ALTER TABLE native_epoch_delegation_policies
  ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'native';
ALTER TABLE native_epoch_delegation_policies
  ALTER COLUMN credential_reference DROP NOT NULL;
ALTER TABLE native_epoch_delegation_policies
  ALTER COLUMN credential_generation DROP NOT NULL;
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_request_id_check;
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_check;
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_source_check;
ALTER TABLE native_epoch_delegation_policies
  ADD CONSTRAINT native_epoch_delegation_policies_source_check
    CHECK (source IN ('native', 'cutover'));
ALTER TABLE native_epoch_delegation_policies
  ADD CONSTRAINT native_epoch_delegation_policies_request_id_check
    CHECK (request_id ~ '^nd[bp]_[A-Za-z0-9_-]{43}$');
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_source_fields_check;
ALTER TABLE native_epoch_delegation_policies
  ADD CONSTRAINT native_epoch_delegation_policies_source_fields_check
    CHECK (
      (source = 'native'
        AND request_id ~ '^ndp_[A-Za-z0-9_-]{43}$'
        AND credential_reference IS NOT NULL
        AND credential_generation = 1
        AND effective_epoch = accepted_epoch + 2)
      OR
      (source = 'cutover'
        AND request_id ~ '^ndb_[A-Za-z0-9_-]{43}$'
        AND credential_reference IS NULL
        AND credential_generation IS NULL
        AND effective_epoch = accepted_epoch)
    );

-- Policies are permanent audit facts, while credentials are revocable and an
-- account's user binding is cleared when that user is deleted. Validate the
-- parent bindings at INSERT time under key-share locks instead of retaining
-- foreign keys that would make those ordinary lifecycle deletes impossible.
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_credential_binding_fkey;
ALTER TABLE native_epoch_delegation_policies
  DROP CONSTRAINT IF EXISTS native_epoch_delegation_policies_account_binding_fkey;

CREATE OR REPLACE FUNCTION validate_native_epoch_policy_bindings()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source = 'native' THEN
    PERFORM 1
      FROM native_session_credentials
     WHERE credential_reference = NEW.credential_reference
       AND credential_generation = NEW.credential_generation
       AND user_id = NEW.user_id
       AND account_id = NEW.account_id
       AND network_id = NEW.network_id
       AND chain_id = NEW.chain_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'native epoch policy credential binding is invalid'
        USING ERRCODE = '23503',
              CONSTRAINT = 'native_epoch_delegation_policies_credential_binding';
    END IF;
  END IF;

  PERFORM 1
    FROM onchain_accounts
   WHERE id = NEW.account_id
     AND user_id = NEW.user_id
     AND address = NEW.account_address
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'native epoch policy account binding is invalid'
      USING ERRCODE = '23503',
            CONSTRAINT = 'native_epoch_delegation_policies_account_binding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS native_epoch_delegation_policy_bindings
  ON native_epoch_delegation_policies;
CREATE TRIGGER native_epoch_delegation_policy_bindings
  BEFORE INSERT ON native_epoch_delegation_policies
  FOR EACH ROW EXECUTE FUNCTION validate_native_epoch_policy_bindings();

CREATE OR REPLACE FUNCTION prevent_native_delegation_cutover_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.cutover_epoch IS NOT NULL THEN
      RAISE EXCEPTION 'native delegation cutover is immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.cutover_epoch IS NOT NULL AND
     (NEW.cutover_epoch IS DISTINCT FROM OLD.cutover_epoch OR
      NEW.cutover_at IS DISTINCT FROM OLD.cutover_at) THEN
    RAISE EXCEPTION 'native delegation cutover is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS native_delegation_cutover_immutable
  ON native_epoch_delegation_fences;
CREATE TRIGGER native_delegation_cutover_immutable
  BEFORE UPDATE OR DELETE ON native_epoch_delegation_fences
  FOR EACH ROW EXECUTE FUNCTION prevent_native_delegation_cutover_change();

-- `account_delegation_periods` is global, so publishing the one canonical C
-- freezes the entire legacy history table. The cutover transaction closes its
-- open rows before setting C; every later write is a second authority.
CREATE OR REPLACE FUNCTION prevent_legacy_delegation_change_after_cutover()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM native_epoch_delegation_fences
     WHERE cutover_epoch IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'legacy delegation history is frozen after cutover';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_delegation_frozen_after_cutover
  ON account_delegation_periods;
CREATE TRIGGER legacy_delegation_frozen_after_cutover
  BEFORE INSERT OR UPDATE OR DELETE ON account_delegation_periods
  FOR EACH ROW EXECUTE FUNCTION prevent_legacy_delegation_change_after_cutover();

CREATE OR REPLACE FUNCTION prevent_native_epoch_policy_change()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'native epoch delegation policies are append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS native_epoch_delegation_policy_append_only
  ON native_epoch_delegation_policies;
CREATE TRIGGER native_epoch_delegation_policy_append_only
  BEFORE UPDATE OR DELETE ON native_epoch_delegation_policies
  FOR EACH ROW EXECUTE FUNCTION prevent_native_epoch_policy_change();

COMMENT ON TABLE native_session_web_incarnations IS 'staging:private';
COMMENT ON TABLE native_session_attempts IS 'staging:private';
COMMENT ON TABLE native_session_handoffs IS 'staging:private';
COMMENT ON TABLE native_session_tickets IS 'staging:private';
COMMENT ON TABLE native_installation_key_generations IS 'staging:private';
COMMENT ON TABLE native_session_credentials IS 'staging:private';
COMMENT ON TABLE native_session_credential_envelopes IS 'staging:private';
COMMENT ON TABLE native_epoch_delegation_policies IS 'staging:private';

-- Onboarding flow alignment — email-only platform waitlist, enforced
-- platform-access gate, block-producer queue (user-onboarding-flows doc).
-- ═══════════════════════════════════════════════════════════════════════

-- Platform waitlist entries are keyed by EMAIL, not by user: joining
-- requires no account (`POST /api/public/waitlist`), and admins can
-- release an email before its owner ever registers. `released_at` is the
-- release marker; when a `users` row with a matching email is created
-- (OTP verify or classic register), the linkage step points
-- `linked_user_id` here and — if already released — grants
-- `has_platform_access` on the spot. Emails are stored lowercased.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id             BIGSERIAL PRIMARY KEY,
  email          VARCHAR(255) NOT NULL UNIQUE,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip             VARCHAR(45),
  answers        JSONB,
  released_at    TIMESTAMPTZ,
  linked_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_released ON waitlist_signups (released_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_linked_user ON waitlist_signups (linked_user_id);
COMMENT ON COLUMN waitlist_signups.ip IS 'staging:private';

-- Two-stage waitlist survey (ported from the original topochain
-- waitlist). `more_token` is the capability for the optional stage-2
-- "Want in sooner?" form — shown once after joining and carried in the
-- join email, it lets the signer re-open and merge answers (and verify
-- GitHub / X handles via OAuth) without an account. NULL for rows that
-- predate the survey.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS more_token VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_more_token
  ON waitlist_signups (more_token) WHERE more_token IS NOT NULL;
COMMENT ON COLUMN waitlist_signups.more_token IS 'staging:private';

-- Email confirmation. Set the first time the signer follows the confirm
-- link in their join mail (GET /api/public/waitlist/confirm/:token, which
-- then lands them on the stage-2 survey). Idempotent — a second visit
-- keeps the original timestamp. A NULL here after a join means the
-- address never proved it can receive mail, which is exactly what an
-- admin wants to see before releasing a row.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- #4594: the release mail's one-time sign-in link (src/services/release-links.js).
-- "Create my account" signs its recipient in once, in place of a second email
-- and a code. Random, stored only as a SHA-256 hash, bound to the row and the
-- address it was minted for, single use, good for 7 days, and spent by a POST
-- from the page, never by the GET that opens it. NOT more_token, which stays
-- prefill-only (#1548). Auth material: private to staging.
CREATE TABLE IF NOT EXISTS waitlist_release_links (
  token_hash   VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  signup_id    BIGINT NOT NULL REFERENCES waitlist_signups(id) ON DELETE CASCADE,
  email        VARCHAR(255) NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_release_links_signup
  ON waitlist_release_links (signup_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_release_links_expires
  ON waitlist_release_links (expires_at);
COMMENT ON TABLE waitlist_release_links IS 'staging:private';

-- The admit mail as the admin Journey's first mile reads it (services/
-- journey.js), kept on the released row after the mail log forgets it. The
-- log (mail_deliveries and its mail_events) keeps 30 days, and a cohort's
-- first mile is read for as long as there is one, so the log's retention
-- sweep (services/mail/index.js pruneDeliveries) copies a released row's
-- facts here in the same statement that deletes them: when its "you're in"
-- mail was first sent, whether one was tracked, its first open and first
-- followed link (never a scanner's or prefetcher's request), and the first
-- sign-in code asked for after the admit. Each is the earliest seen and
-- never moves once set, so a sweep that runs in batches keeps the same
-- values. `release_link_followed_at` is the first spend of the mail's
-- one-time sign-in link (services/release-links.js spend), which click
-- tracking leaves out on purpose and whose rows are deleted a day after
-- they expire: it is written as the link is spent. Times and a flag, like
-- confirmed_at beside them, and no capability: not column-private, which
-- here marks a credential and hides it from the debug role, where these are
-- what somebody debugging a first mile needs. A staging clone empties this
-- table's rows with every other signup surface (migrate.js seeds its own).
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_mail_sent_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_mail_tracked BOOLEAN;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_mail_opened_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_mail_clicked_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_code_asked_at TIMESTAMPTZ;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS release_link_followed_at TIMESTAMPTZ;

-- Outbound mail log (src/services/mail/). Every send attempt lands here
-- with its outcome, and it is the ONLY place an operator can see what
-- happened: the endpoints that trigger mail are always-200 by contract
-- (SPEC 1667) so they cannot report a delivery failure to the user, and a
-- non-delivery was historically invisible for exactly that reason.
--
-- It is also the throttle's state: src/services/mail/rate-limit.js counts
-- the `sent` / `skipped_staging` rows for a recipient to cap how much mail
-- one address can be made to receive, and counts them globally to bound
-- the provider bill.
--
-- `status` is one of:
--   sent                  delivered to the provider
--   skipped_staging       rendered to the log by a staging preview
--   failed                the provider refused or timed out (`error` says)
--   suppressed_rate_limit the throttle declined it (`error` says why)
--   no_transport          nothing was configured to send it
-- `error` holds a bounded provider complaint. It NEVER holds the message
-- body, so a login code cannot end up in this table.
CREATE TABLE IF NOT EXISTS mail_deliveries (
  id         BIGSERIAL PRIMARY KEY,
  kind       VARCHAR(64) NOT NULL,
  recipient  VARCHAR(255) NOT NULL,
  provider   VARCHAR(32),
  status     VARCHAR(24) NOT NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The throttle's read path: newest rows for one recipient and kind.
CREATE INDEX IF NOT EXISTS idx_mail_deliveries_recipient
  ON mail_deliveries (recipient, kind, created_at DESC);
-- The global hourly count, the admin card's "recent activity", and the
-- retention sweep all walk the table by time.
CREATE INDEX IF NOT EXISTS idx_mail_deliveries_created
  ON mail_deliveries (created_at DESC);
-- Staging privacy (see the convention block earlier in this file): a log
-- of who the platform emailed and when is private user content, so a
-- staging clone starts empty and gets obviously-fake seed rows instead
-- (seedStagingPlatformMail in src/db/migrate.js).
--
-- Deliberately NOT added to the prod-debug deny lists in
-- src/services/debug-access.js: this table holds no password, key or
-- token, and "did that user's login code actually go out" is precisely the
-- question an admin debugging session needs to be able to answer.
COMMENT ON TABLE mail_deliveries IS 'staging:private';

-- Opaque identity, never the serial or the recipient, on public mail links.
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS tracking_links JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mail_deliveries ADD COLUMN IF NOT EXISTS engagement_tracked BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_deliveries_message_id
  ON mail_deliveries (message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_deliveries_provider_message_id
  ON mail_deliveries (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id BIGINT NOT NULL REFERENCES mail_deliveries(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('delivered', 'bounced', 'complained', 'opened', 'clicked', 'unsubscribed')),
  url TEXT,
  user_agent_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_mail_events_delivery_type ON mail_events (delivery_id, type);
CREATE INDEX IF NOT EXISTS idx_mail_events_created_type ON mail_events (created_at DESC, type);
COMMENT ON TABLE mail_events IS 'staging:private';

-- Safety state survives the delivery log's 30-day retention sweep.
CREATE TABLE IF NOT EXISTS mail_suppressions (
  recipient TEXT PRIMARY KEY CHECK (recipient = lower(recipient)),
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE mail_suppressions IS 'staging:private';


-- Access + block-production state on the user. `has_platform_access`
-- gates the SV platform surfaces (home/social/build) — NOT login-required
-- child apps, which any account may use (see src/middleware/auth.js).
-- `bp_requested_at`/`bp_released_at` are the block-producer queue: any
-- user with platform access may ask to produce blocks; an admin releases
-- them manually, which is what lets the mobile node enable its block
-- producer (surfaced via GET /api/v4/mobile/me).
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_platform_access        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_access_granted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bp_requested_at            TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bp_released_at             TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_has_platform_access ON users (has_platform_access);

-- One-time grandfather + legacy-waitlist backfill, guarded by a
-- platform_settings marker key because this whole file re-runs on every
-- boot. First boot after deploy: every pre-existing account keeps full
-- access (the gate only bites signups created after this ships), and the
-- migrated topochain waitlist columns on `users` are copied into
-- `waitlist_signups` (those legacy columns stay read-only thereafter).
-- Later boots: the marker exists, both statements are no-ops.
UPDATE users
  SET has_platform_access = TRUE, platform_access_granted_at = NOW()
  WHERE NOT EXISTS
    (SELECT 1 FROM platform_settings WHERE key = 'onboarding_gate_grandfathered');

INSERT INTO waitlist_signups (email, submitted_at, ip, answers, linked_user_id)
  SELECT LOWER(u.email), COALESCE(u.waitlist_submitted_at, NOW()),
         u.waitlist_ip, u.waitlist_answers, u.id
  FROM users u
  WHERE u.is_in_waitlist = TRUE AND u.email IS NOT NULL
    AND NOT EXISTS
      (SELECT 1 FROM platform_settings WHERE key = 'onboarding_gate_grandfathered')
ON CONFLICT (email) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
  ('onboarding_gate_grandfathered', 'true',
    'Marker: the one-time platform-access grandfather + waitlist backfill has run. Do not delete — deleting re-grants access to every account on next boot.')
ON CONFLICT (key) DO NOTHING;

-- #2592: the moment the platform began recording coding-agent spend
-- per model (the chat_session_agent_model_costs table, far above).
--
-- Stamped on the first boot that carries this table, in the same marker
-- style as `onboarding_gate_grandfathered` above: ON CONFLICT DO NOTHING,
-- so every later boot is a no-op and the stamp never moves.
--
-- WHY A CUTOFF: every session that predates this row spent its
-- coding-agent money with no model attached, and that history cannot be
-- backfilled (llm_usage is per user per day, with no session or model).
-- An aggregate that mixed those sessions in would keep reporting the
-- understated figure this change exists to fix, so services/model-costs.js
-- counts only sessions CREATED at or after this instant. The set grows on
-- its own as history accumulates, exactly like the `agent_cost_cents > 0`
-- filter it replaces. Deleting this row does not "reset" anything useful:
-- the next boot re-stamps it at NOW() and throws away every clean change
-- recorded so far.
INSERT INTO platform_settings (key, value, description) VALUES
  ('model_cost_observed_since', NOW()::text,
    'Marker: the instant the platform began recording coding-agent spend per model (#2592). The Model costs console counts only changes created at or after it. Do not delete — deleting re-stamps it at the next boot and discards every clean change recorded so far.')
ON CONFLICT (key) DO NOTHING;

-- ── Hosted MCP connector: OAuth 2.1 authorization server ────────────────
--
-- Claude.ai and ChatGPT connect to the platform's remote MCP endpoint
-- (POST /mcp) as PUBLIC OAuth clients: dynamic client registration, the
-- authorization-code grant with mandatory PKCE S256, and rotating refresh
-- tokens. These are deliberately SEPARATE tables from the CLI's
-- cli_access_tokens / cli_auth_audit_events family, whose CHECK
-- constraints pin client_id to the single first-party CLI identity and
-- scopes to that flow's two values — a third-party connector fits neither.
--
-- All three are staging:private: they hold (hashed) credential material
-- and a staging clone must never carry a live grant. The Settings section
-- that lists them therefore renders from a ?demo=1 fixture in staging.

CREATE TABLE IF NOT EXISTS mcp_clients (
  id               BIGSERIAL PRIMARY KEY,
  client_id        TEXT NOT NULL UNIQUE,
  client_name      TEXT NOT NULL,
  -- Every entry is https (or loopback in explicit local-dev mode) and its
  -- host is on the deployment's connector allowlist; the registration
  -- route is the enforcement point.
  redirect_uris    TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at      TIMESTAMPTZ,
  CHECK (char_length(client_name) BETWEEN 1 AND 128)
);
COMMENT ON TABLE mcp_clients IS 'staging:private';

-- Authorization codes. Single-use, 60s TTL, bound to client + redirect +
-- PKCE challenge, stored hashed. The consumed_at/expires_at pairing is
-- expressed as constraints so an inconsistent row cannot be written.
CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
  id             BIGSERIAL PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes         TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) BETWEEN 1 AND 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  grant_id       TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
COMMENT ON TABLE mcp_authorization_codes IS 'staging:private';

-- Access + refresh tokens. grant_id groups everything minted from one
-- consent so Settings → Disconnect revokes the whole chain in one write;
-- rotated_from records refresh rotation so reuse of a consumed refresh
-- token can be detected and the chain killed.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL,
  grant_id     TEXT NOT NULL,
  scopes       TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) BETWEEN 1 AND 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  rotated_from BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
COMMENT ON TABLE mcp_tokens IS 'staging:private';

CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx
  ON mcp_tokens (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mcp_tokens_grant_idx
  ON mcp_tokens (grant_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_expiry_idx
  ON mcp_tokens (expires_at);
CREATE INDEX IF NOT EXISTS mcp_authorization_codes_expiry_idx
  ON mcp_authorization_codes (expires_at);

-- Connector auth audit. Same event vocabulary and same
-- metadata-allowlist discipline as cli_auth_audit_events, but with a free
-- client_id (a third-party connector is not the first-party CLI) and the
-- connector scope set.
CREATE TABLE IF NOT EXISTS mcp_auth_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      TEXT NOT NULL
    CHECK (event_type IN (
      'authorization_approved', 'authorization_rejected',
      'token_issued', 'token_used', 'token_revoked'
    )),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  access_token_id BIGINT,
  client_id       TEXT NOT NULL,
  scopes          TEXT[] NOT NULL
    CHECK (
      cardinality(scopes) <= 2
      AND scopes <@ ARRAY['usernode:apps:read', 'usernode:proposals:write']::TEXT[]
    ),
  outcome         TEXT NOT NULL DEFAULT 'success'
    CHECK (
      (event_type = 'token_used'
       AND outcome IN ('scope_authorized', 'insufficient_scope'))
      OR (event_type <> 'token_used' AND outcome = 'success')
    ),
  metadata        JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(metadata) = 'object')
);
COMMENT ON TABLE mcp_auth_audit_events IS 'staging:private';

CREATE INDEX IF NOT EXISTS mcp_auth_audit_events_user_idx
  ON mcp_auth_audit_events (user_id, occurred_at DESC);

-- Throttle state for the in-band "you can stop these permission prompts"
-- hint that rides along on a read-only tool result.
--
-- Keyed on grant_id, not on an MCP session: /mcp is STATELESS
-- (sessionIdGenerator: undefined — a fresh McpServer per HTTP request), so
-- there is no session id to key on and "once per session" is not something
-- this server can express. A grant is the nearest durable thing that means
-- "this connection", and it survives the hourly access-token rotation, which
-- is what stops the hint reappearing every hour forever.
--
-- What decides "a new conversation" is armed_at, NOT the access token.
-- last_token_id used to be that gate — a claim was refused when the calling
-- token matched the last one — on the theory that an hourly token is roughly
-- a conversation. It is not: one token serves every conversation opened in
-- that hour, so the first eligible read consumed the only slot and every
-- conversation afterwards got nothing. In production that produced exactly
-- one row, ever. armed_at is written when the client sends `initialize`,
-- which is the protocol actually saying a session has started, and a claim is
-- granted when the row has been armed since it was last shown. The column
-- stays as a DIAGNOSTIC: written on every showing, read by nothing.
--
-- shown_count is a ROLLING budget, not a lifetime cap: at most 3 showings per
-- window_started_at + 7 days, with the window rolled forward inside the claim
-- statement. The lifetime cap it replaced had no reset path, so a connection
-- that spent it went quiet permanently.
--
-- Advisory state, never authoritative: a failed claim is logged and the read
-- returns without a hint. Nothing here gates access to anything.
CREATE TABLE IF NOT EXISTS mcp_connector_hints (
  grant_id      TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shown_count   INTEGER NOT NULL DEFAULT 0,
  last_token_id BIGINT,
  last_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE mcp_connector_hints IS 'staging:private';

-- Added after the table shipped, so they arrive as idempotent ALTERs like
-- every other post-hoc column in this file.
--
-- armed_at is NULLABLE on purpose: NULL means "not armed", and a showing
-- clears it, so one initialize buys one showing rather than every read in the
-- session. It has no DEFAULT for the same reason — a row created by the claim
-- path (a client mid-session when this shipped) must not look armed.
--
-- window_started_at is NOT NULL DEFAULT NOW(), which back-fills every existing
-- row to "the window starts now". That is the deliberate choice: it gives the
-- one grant that spent its lifetime cap under the old rules a fresh weekly
-- budget rather than leaving it locked out.
ALTER TABLE mcp_connector_hints ADD COLUMN IF NOT EXISTS armed_at TIMESTAMPTZ;
ALTER TABLE mcp_connector_hints
  ADD COLUMN IF NOT EXISTS window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Delegated connector grants (#2779). The platform's own agents reach the
-- same tool registry an external chat product does, on the user's behalf:
-- the Mayor of an agent session (`agent_mayor`) and the coding agent inside
-- one change's worker (`worker_read`). One row per grant; the access token
-- itself is an ordinary mcp_tokens row with the same grant_id, minted by
-- services/mcp-oauth.js issueDelegatedAccess with no refresh token and a
-- synthetic client id that no consent or token endpoint accepts.
--
-- The KIND is set by the server when it issues the grant and is what decides
-- which tools and routes the token may reach (services/mcp-audiences.js,
-- services/cli-api-policy.js). Liveness is checked on EVERY request by
-- joining this table, so revoking the row, expiring it, or closing the
-- change it names ends the token with no hook having to run.
--
-- agent_session_id carries no foreign key yet: agent_sessions arrives in the
-- next step of #2779, which adds the constraint with the table. change_id and
-- app_id bind a worker token to one change and that change's app.
CREATE TABLE IF NOT EXISTS mcp_delegations (
  grant_id         TEXT PRIMARY KEY CHECK (grant_id ~ '^[A-Za-z0-9_-]{22}$'),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('agent_mayor', 'worker_read')),
  agent_session_id INTEGER,
  change_id        INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  app_id           INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (kind <> 'worker_read' OR (change_id IS NOT NULL AND app_id IS NOT NULL))
);
COMMENT ON TABLE mcp_delegations IS 'staging:private';

CREATE INDEX IF NOT EXISTS mcp_delegations_user_idx
  ON mcp_delegations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_delegations_change_idx
  ON mcp_delegations (change_id) WHERE change_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_delegations_agent_session_idx
  ON mcp_delegations (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_delegations_expiry_idx
  ON mcp_delegations (expires_at);

-- ── Verified GitHub account link (IDENTITY ONLY) ────────────────────────
-- Distinct from the self-declared `users.github` profile string above,
-- which is unverified display text and must NEVER be used for
-- authorization. These are written only by the OAuth round-trip in
-- src/services/github-link.js, which asks GitHub for NO SCOPE: the login
-- is the whole link, and the platform holds no credential for the user.
--
-- github_oauth_token_enc is LEGACY and always NULL. It once held a
-- `public_repo` token used to fork an app repo into the user's account on
-- their behalf; that fork is now made by the user's own coding agent.
-- saveLink writes NULL, and migrate.js's revokeLegacyGithubGrants hands
-- any pre-existing token back to GitHub and clears it. Kept (rather than
-- dropped) so a rollback to the previous release cannot hit a missing
-- column mid-deploy; drop it once every deployment has migrated.
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login             VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_oauth_token_enc   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_linked_at         TIMESTAMPTZ;
COMMENT ON COLUMN users.github_oauth_token_enc IS 'staging:private';

-- Generic social-account ownership proofs used by the opt-in identity
-- credit policy. `provider_subject` is the provider's immutable numeric id;
-- the handle is presentation/attribution metadata and may change. One
-- provider account can belong to only one Usernode account, while linking
-- both providers never stacks the tier. No OAuth access or refresh token is
-- stored here (or anywhere else after the callback completes).
CREATE TABLE IF NOT EXISTS user_social_identities (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'x')),
  provider_subject    VARCHAR(40) NOT NULL CHECK (provider_subject ~ '^[1-9][0-9]{0,39}$'),
  handle              VARCHAR(64) NOT NULL,
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_visible      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (user_id, provider),
  UNIQUE (provider, provider_subject)
);
ALTER TABLE user_social_identities
  ADD COLUMN IF NOT EXISTS public_visible BOOLEAN NOT NULL DEFAULT TRUE;
COMMENT ON TABLE user_social_identities IS 'staging:private';
CREATE INDEX IF NOT EXISTS user_social_identities_user_idx
  ON user_social_identities (user_id);

-- Single-use OAuth state. The browser receives the random state value while
-- this table stores only its SHA-256 hash plus the server-side PKCE verifier.
-- Starting a replacement flow invalidates the previous one for that
-- user/provider; callbacks atomically DELETE ... RETURNING before exchange.
CREATE TABLE IF NOT EXISTS social_identity_oauth_states (
  state_hash       CHAR(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'x')),
  intent           VARCHAR(16) NOT NULL DEFAULT 'connect'
                     CHECK (intent IN ('connect', 'refresh', 'replace')),
  pkce_verifier    VARCHAR(128) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, provider)
);
ALTER TABLE social_identity_oauth_states
  ADD COLUMN IF NOT EXISTS intent VARCHAR(16) NOT NULL DEFAULT 'connect'
    CHECK (intent IN ('connect', 'refresh', 'replace'));
COMMENT ON TABLE social_identity_oauth_states IS 'staging:private';
CREATE INDEX IF NOT EXISTS social_identity_oauth_states_expiry_idx
  ON social_identity_oauth_states (expires_at);

-- Provider-verified replacement awaiting the user's same-origin confirmation.
-- The current identity remains authoritative until this short-lived row is
-- consumed transactionally. As with the durable proof, it stores no token.
CREATE TABLE IF NOT EXISTS social_identity_pending_replacements (
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            VARCHAR(16) NOT NULL CHECK (provider IN ('github', 'x')),
  provider_subject    VARCHAR(40) NOT NULL CHECK (provider_subject ~ '^[1-9][0-9]{0,39}$'),
  handle              VARCHAR(64) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, provider),
  CHECK (expires_at > created_at)
);
COMMENT ON TABLE social_identity_pending_replacements IS 'staging:private';
CREATE INDEX IF NOT EXISTS social_identity_pending_replacements_expiry_idx
  ON social_identity_pending_replacements (expires_at);

-- Which external coding agent produced a proposal, for the "built with
-- Claude Code" / "built with Codex" badge. Deliberately a SEPARATE column
-- rather than a new `source` value: `source = 'imported'` is compared for
-- exact equality in ~10 places (sync-main, staging-recovery, pr-vote-
-- revision, the chat-turn guard, …) and every one of those behaviours is
-- wanted for an externally-authored branch.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS external_agent   TEXT;

-- ── External-agent work orders ──────────────────────────────────────────
--
-- One row per "the connector handed a task to the user's own coding agent
-- and is waiting for the branch to come back". It is the server's memory of
-- what prepare_work promised, so submit_work can check that the branch it
-- is asked to import is the branch it reserved, in the fork it reserved,
-- from the base commit it recorded — rather than trusting the three strings
-- the model hands back.
--
-- `staging:private`: rows tie a Usernode account to a personal GitHub
-- account and to in-flight, unpublished work. They carry no credential
-- (the OAuth token lives encrypted on `users`), so they are not in the
-- prod-debug deny list; they are simply not other people's business and
-- must not ride along into a staging clone. This table references public
-- tables, never the reverse.
CREATE TABLE IF NOT EXISTS external_agent_tasks (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number  INTEGER,
  fork_owner    TEXT NOT NULL,
  fork_repo     TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  brief         TEXT NOT NULL DEFAULT '',
  client_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'submitted', 'abandoned')),
  session_id    INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days'
);
COMMENT ON TABLE external_agent_tasks IS 'staging:private';

-- At most one OPEN task per (user, app, branch): re-running prepare_work
-- for the same branch adopts the existing reservation instead of minting a
-- second one, and two connectors racing cannot both reserve it.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_tasks_open_branch_idx
  ON external_agent_tasks (user_id, app_id, branch_name)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS external_agent_tasks_user_idx
  ON external_agent_tasks (user_id, created_at DESC);

-- ── Idempotency and submission provenance ────────────────────────────
--
-- The branch index above DOCUMENTS "at most one open task per request" and
-- has never once delivered it: prepare_work invents a fresh random nonce for
-- every branch name, so the index can only ever catch a nonce collision.
-- Production proved it — three OPEN rows for one request (#50 on app 156),
-- minted 15:29 / 16:02 / 17:35 UTC on 2026-08-07, each holding a slot of the
-- caller's open-work-order bound and each with a different branch the agent felt
-- obliged to rewrite its finished commit to match.
--
-- request_key is the key the behaviour actually needs: `issue:<n>` when the
-- work implements a numbered request, else `brief:<sha256 prefix>` of the
-- brief. prepare_work now looks it up and RETURNS the existing task instead
-- of minting a second one.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS request_key TEXT;

-- How the submission actually reached GitHub, recorded so the 2026-08-07
-- failure is answerable from SQL alone next time:
--   branch           — the plain cross-fork create worked
--   branch_head_repo — it only worked once head_repo disambiguated the fork
--   mirror           — the fork branch had to be copied into the app's repo
--   patch            — the agent could not push at all and sent a patch
--   pr               — the caller named an already-open pull request
-- `branch` vs `branch_head_repo` is precisely the question "was the missing
-- head_repo parameter the whole bug?".
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_branch TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_via TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_source TEXT;
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS submitted_client_id TEXT;

-- Which existing proposal this work order UPDATES, when prepare_work was
-- called with a proposalId (#1054). NULL is the original behaviour: the work
-- order opens a NEW proposal. ON DELETE SET NULL because the task row is the
-- audit trail of what an agent was asked to do, and it outlives the proposal.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS target_session_id BIGINT
  REFERENCES chat_sessions(id) ON DELETE SET NULL;

-- Which chat session a work order was PREPARED in — the launchpad the user was
-- standing in when they pressed "Prepare work order".
--
-- THREE session columns now sit on this table and they mean three different
-- things. Confusing them is not a style problem, it breaks the product:
--   session_id        — the shared in-progress session this work BECAME. Set
--                       only once work has been shared or submitted; an OPEN
--                       task carrying one is a card already on the Dev board,
--                       and submitWork REFUSES it with `already_shared`.
--   target_session_id — the proposal or session this work order UPDATES.
--   origin_session_id — this one. Pure provenance, written at mint time,
--                       read by the walkthrough and by nothing else.
--
-- Before it existed the walkthrough resolved its task per (user, app), so one
-- open work order spoke for every session in the app: "New change" opened a
-- fresh session that immediately showed somebody else's half-finished order,
-- with no relationship to the change the user had just asked to start.
--
-- NULL means "prepared before this column existed, or through the connector,
-- which has no session". Those rows are adopted by the first launchpad that
-- looks for one, so they are not stranded — see loadOpenTaskForSession.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS origin_session_id INTEGER
  REFERENCES chat_sessions(id) ON DELETE SET NULL;

-- The walkthrough's lookup: the caller's open task for one app and one session.
CREATE INDEX IF NOT EXISTS external_agent_tasks_origin_session_idx
  ON external_agent_tasks (user_id, app_id, origin_session_id)
  WHERE status = 'open';

-- ── Close out the attempts that leaked before they had an ending ──────
--
-- A work order is one ATTEMPT at an issue. It had a beginning and two endings
-- (submit, "Start over") but none for "the session it belonged to is over", so
-- dead attempts accumulated: each holding one of ten open-work-order slots for
-- its full 14-day expiry. The launchpad then tried to hand them back out — a
-- new change claimed the newest orphan, so starting one change after another
-- walked the user down the pile instead of opening clean.
--
-- BROWSER-MINTED ONLY. `usernode-web:%` is the client_id the dev-flow route
-- writes; rows from the CONNECTOR (Claude, ChatGPT) have no session by nature,
-- are genuinely in flight, and submit by task id without ever needing a
-- launchpad. Closing those would break live work.
--
-- The `created_at` bound is what makes this ONE-TIME rather than a rule. The
-- WHERE clause would otherwise keep matching on every boot, and would then
-- close an order minted by a browser still running JS cached from before the
-- client started sending its session — a user whose launchpad can still see
-- it. A fixed instant, set when this shipped, cannot reach anything minted
-- afterwards. Re-running is a no-op either way, which is the convention the
-- request_key backfill above follows.
UPDATE external_agent_tasks
SET status = 'abandoned'
WHERE status = 'open'
  AND origin_session_id IS NULL
  AND session_id IS NULL
  AND client_id LIKE 'usernode-web:%'
  AND created_at < TIMESTAMPTZ '2026-09-12 13:00:00+00';

DO $$
BEGIN
  -- The update path adds two more values (#1054):
  --   update_branch    — the fork branch was pushed onto the proposal's
  --                      bot-owned branch in the app repo
  --   update_fork_head — the proposal's head already lived in the author's
  --                      fork, so advancing the tracked head WAS the write
  -- And #4263 adds a third:
  --   update_patch     — the author's patch was applied on the proposal's
  --                      head and pushed onto that same bot-owned branch
  -- Widening a CHECK means replacing it, so this one constraint is dropped
  -- and recreated rather than added-if-absent. Safe on every boot: the new
  -- list is a superset, so no stored value can be excluded by it.
  ALTER TABLE external_agent_tasks DROP CONSTRAINT IF EXISTS external_agent_tasks_submitted_via_chk;
  ALTER TABLE external_agent_tasks ADD CONSTRAINT external_agent_tasks_submitted_via_chk
    CHECK (submitted_via IS NULL OR submitted_via IN (
      'branch','branch_head_repo','mirror','patch','pr','update_branch','update_fork_head','update_patch'));
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'external_agent_tasks_submitted_source_chk'
  ) THEN
    ALTER TABLE external_agent_tasks ADD CONSTRAINT external_agent_tasks_submitted_source_chk
      CHECK (submitted_source IS NULL OR submitted_source IN ('work_order','assistant'));
  END IF;
END $$;

-- Forward-only backfill, same shape as the chat_sessions one below.
--
-- DEDUPE BEFORE BACKFILL, not after. Filling the key first would make two
-- open rows collide the moment they got their keys, which fails outright on
-- any boot where the unique index already exists — and this file is applied
-- on EVERY boot, not once. So the duplicate check computes the key inline
-- (`COALESCE(request_key, <what it would be>)`) and closes the losers first;
-- by the time the backfill runs, no two open rows can share a key.
--
-- Newest kept, because that is the one whose branch the agent actually
-- pushed — production's three rows for request #50 differ only in their
-- branch nonce, and only the last one exists on GitHub.
UPDATE external_agent_tasks t
SET status = 'abandoned'
WHERE t.status = 'open'
  AND EXISTS (
    SELECT 1 FROM external_agent_tasks newer
     WHERE newer.status = 'open'
       AND newer.user_id = t.user_id
       AND newer.app_id = t.app_id
       AND newer.id > t.id
       AND COALESCE(
             newer.request_key,
             CASE WHEN newer.issue_number IS NOT NULL
                  THEN 'issue:' || newer.issue_number::text
                  ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(newer.brief, ''), 'UTF8')), 'hex'), 1, 32)
             END
           ) = COALESCE(
             t.request_key,
             CASE WHEN t.issue_number IS NOT NULL
                  THEN 'issue:' || t.issue_number::text
                  ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(t.brief, ''), 'UTF8')), 'hex'), 1, 32)
             END
           )
  );

-- sha256 over the stored (already-trimmed) brief, hex, first 32 chars —
-- byte-identical to what services/external-agent-tasks.js computes, so a row
-- backfilled here is FOUND by the next prepare_work rather than duplicated.
UPDATE external_agent_tasks
SET request_key = CASE
      WHEN issue_number IS NOT NULL THEN 'issue:' || issue_number::text
      ELSE 'brief:' || substr(encode(sha256(convert_to(coalesce(brief, ''), 'UTF8')), 'hex'), 1, 32)
    END
WHERE request_key IS NULL;

-- At most one OPEN task per (user, app, request). This is the constraint the
-- branch index above was always meant to be.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_tasks_open_request_idx
  ON external_agent_tasks (user_id, app_id, request_key)
  WHERE status = 'open';

-- ── Release the slots a shared session stranded ──────────────────────
--
-- `share: true` leaves the work order OPEN on purpose — the agent keeps
-- committing onto the in-progress card — and stamps `session_id` on the row.
-- The promote that ends that arrangement is `submit_work({ proposalId,
-- branch, propose: true })`, which carries no taskId, so until the fix in
-- services/external-agent-tasks.js + services/mcp-tools.js nothing ever
-- closed those rows. Each one held a slot of its owner's ten-open-work-order
-- bound until it expired fourteen days later; one account hit the cap with
-- ten rows it could not see, none of which were work it was still doing.
--
-- Forward-only and idempotent, like the backfills above: it can only move
-- rows OUT of 'open', so a later boot finds nothing left to do, and it never
-- touches a session that is still being built.
--
-- Two outcomes, because the two are not the same story:
--   'submitted' — the session reached the group (promoted / merging /
--                 merged). The work order did its job; only the bookkeeping
--                 was missing.
--   'abandoned' — the session was archived. The work was put away, and
--                 recording it as submitted would claim something false.
--
-- `session_id` is ON DELETE SET NULL, so a row whose session is gone keeps
-- no handle at all — those are left to the expiry, which is the only honest
-- reading of them.
UPDATE external_agent_tasks t
SET status = CASE WHEN s.status = 'archived' THEN 'abandoned' ELSE 'submitted' END
FROM chat_sessions s
WHERE t.session_id = s.id
  AND t.status = 'open'
  AND s.status NOT IN ('active', 'paused');

-- Every request a work order implements. issue_number holds one, and a job
-- asked to implement several used to keep none of them: prepare_work took a
-- single requestNumber, so three requests built together went in as free
-- text, and their proposal merged with no `Closes #N` line and no link, and
-- left all three open. This holds the whole set, issue_number included, and
-- is what the submission links and closes. The empty array on an older row
-- means "just issue_number", exactly what it always meant.
ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS linked_issues INTEGER[] NOT NULL DEFAULT '{}';

-- ── External-agent patch uploads (#4264) ─────────────────────────────
--
-- A patch reached submit_work only as a tool ARGUMENT, which the coding agent
-- had to reproduce character by character: 63 KB and 134 KB in one session,
-- and one slip in another (#4176) made the patch fail to apply and cost a
-- round. prepare_work now also prints a one-time upload command; the agent
-- pipes `git format-patch` into curl, the bytes land here, and submit_work
-- takes the upload's id instead of `patch`. services/
-- external-agent-patch-upload.js has the whole design.
--
-- Two tables, because a work order can be rendered more than once for one
-- task (asking again for the same request returns the same task, with a
-- fresh command) while a task keeps at most one upload.
--
-- external_agent_upload_tokens holds the credentials, as SHA-256 hashes only:
-- the token itself is in the work order returned to the task's owner and
-- nowhere else. Each is bound to one task, works on the upload route alone,
-- and lapses after 24 hours (sooner if the task expires) or as soon as the
-- task is no longer open. On the prod-debug deny list (debug-access.js).
--
-- external_agent_patch_uploads holds the newest patch uploaded for a task, as
-- the exact bytes sent. Uploading again replaces it under a NEW id, so a
-- submission naming an older id is refused rather than sending bytes the
-- agent did not send. Deleted once the task is submitted with it, and swept
-- when the task is closed or expires.
--
-- `staging:private`, like the tasks they belong to: unpublished work in
-- flight, and credential hashes.
CREATE TABLE IF NOT EXISTS external_agent_upload_tokens (
  id          BIGSERIAL PRIMARY KEY,
  task_id     BIGINT NOT NULL REFERENCES external_agent_tasks(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE external_agent_upload_tokens IS 'staging:private';
COMMENT ON COLUMN external_agent_upload_tokens.token_hash IS 'staging:private';
CREATE INDEX IF NOT EXISTS external_agent_upload_tokens_task_idx
  ON external_agent_upload_tokens (task_id);

CREATE TABLE IF NOT EXISTS external_agent_patch_uploads (
  id          BIGSERIAL PRIMARY KEY,
  task_id     BIGINT NOT NULL UNIQUE REFERENCES external_agent_tasks(id) ON DELETE CASCADE,
  token_id    BIGINT REFERENCES external_agent_upload_tokens(id) ON DELETE SET NULL,
  patch       BYTEA NOT NULL,
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  sha256      TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE external_agent_patch_uploads IS 'staging:private';

-- ── Generic agent backend (Codex/OpenRouter BYOK; plan.md PR1) ───────
-- chat_sessions today pins Claude continuity via cc_session_id. To add a
-- second coding-agent backend (codex_openrouter) without breaking the
-- Claude path, we generalize the session's agent configuration into its
-- own columns. Each field is nullable / defaulted so legacy rows stay on
-- claude_code with zero migration work; cc_session_id remains the source
-- of truth for existing Claude threads until PR8's legacy cleanup.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_backend            VARCHAR(32) NOT NULL DEFAULT 'claude_code';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_provider           VARCHAR(32);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_model              VARCHAR(255);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_reasoning_effort   VARCHAR(16);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_thread_id          VARCHAR(128);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_config_version     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_context_reset_at   TIMESTAMPTZ;

-- Backfill: every existing session is a Claude session. Carry the Claude
-- continuity id into the generic agent_thread_id so backend-neutral code
-- can read one field for both backends, while cc_session_id remains
-- readable during the migration window (plan.md §5.4).
--
-- Gated with `agent_thread_id IS DISTINCT FROM cc_session_id` instead of
-- the old `agent_thread_id IS NULL`: rows whose thread already equals the
-- cc_session_id are skipped entirely, so a NULL->NULL rewrite (locks, WAL,
-- dead tuples) no longer happens on every boot.
UPDATE chat_sessions
SET agent_backend = 'claude_code',
    agent_provider = 'anthropic',
    agent_thread_id = cc_session_id
WHERE agent_backend = 'claude_code'
  AND (
    agent_thread_id IS DISTINCT FROM cc_session_id
    OR agent_provider IS DISTINCT FROM 'anthropic'
  );

-- ── The session's chosen build venue (#1281) ─────────────────────────
-- #1086 introduced the six-venue vocabulary in public/js/build-venues.js
-- and stated, correctly for that change, that a venue id is a PRESENTATION
-- key that never travels to the server: every venue was already expressible
-- through a column that existed (agent_backend for the two in-chat Usernode
-- venues, a live lease for `local`, source='imported' for a pull request
-- somebody brought in).
--
-- #1281 breaks that tie, because it asks for something none of those
-- columns can say: a session whose owner has DECIDED to build it somewhere
-- else and has not done it yet. `external_agent` is stamped at SUBMISSION
-- (services/external-agent-tasks.js) — it is provenance, the answer to
-- "where did this proposal come from", and it is null for the whole period
-- the launchpad is the thing the user is looking at. Deriving the venue
-- from the other columns therefore reverts a hand-off session to
-- "Usernode · Claude" on the next reload, taking its launchpad with it.
--
-- So the CHOICE is persisted here, and it is the only place a venue id is
-- stored. Nullable on purpose: NULL means "nobody has chosen", and
-- BuildVenues.currentVenue() then derives exactly as it does today, which
-- is what keeps every existing row correct with no backfill. The CHECK
-- pins the domain to the six ids in build-venues.js; adding a seventh
-- venue means editing this list on purpose, the same bargain
-- users.dev_flow_preference already makes.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS build_venue TEXT;

DO $$
BEGIN
  ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_build_venue_chk;
  ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_build_venue_chk
    CHECK (build_venue IS NULL
           OR build_venue IN ('usernode-claude', 'usernode-openrouter', 'local',
                              'web-claude-code', 'web-codex', 'own-tools-pr'));
END $$;

-- ── Generic user AI credentials (plan.md PR2) ────────────────────────
-- Generalization of users.anthropic_key_enc/_last4 so a second provider
-- (openrouter) can be stored without stacking another pair of columns.
--
-- provider:  anthropic | openrouter
-- purpose:   coding_agent | app_llm
-- For this feature we add provider='openrouter', purpose='coding_agent'.
-- The encryption envelope is unchanged (secrets.js AES-256-GCM), so
-- existing Anthropic ciphertext can be copied in without decrypting.
--
-- On deletion we keep a tombstone row (status='revoked', secret_enc
-- cleared, revision incremented, revoked_at set) so session/audit
-- references stay safe; we never physically delete the row.
-- Credentials live in a dedicated PRIVATE schema (not `public`). The
-- prod-debug role bootstrap (src/services/debug-access.js) only sweeps
-- `public` (REVOKE/GRANT ALL TABLES IN SCHEMA public), so rolled-back
-- (old) code cannot re-grant SELECT on this table — the schema boundary
-- is rollback-persistent DB state, independent of the JS deny-list.
CREATE SCHEMA IF NOT EXISTS credentials;
CREATE TABLE IF NOT EXISTS credentials.user_ai_credentials (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider             VARCHAR(32) NOT NULL,
  purpose              VARCHAR(32) NOT NULL,
  secret_enc           TEXT,
  secret_last4         VARCHAR(8),
  secret_fingerprint   VARCHAR(64),
  status               VARCHAR(16) NOT NULL DEFAULT 'unverified',
  revision             INTEGER NOT NULL DEFAULT 1,
  verified_at          TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  last_error_code      VARCHAR(64),
  revoked_at           TIMESTAMPTZ,
  metadata             JSONB NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_ai_credentials_provider_check
    CHECK (provider IN ('anthropic', 'openrouter')),
  CONSTRAINT user_ai_credentials_purpose_check
    CHECK (purpose IN ('coding_agent', 'app_llm')),
  -- status/verified_at coupling: a usable ('valid') row must carry a
  -- verified_at timestamp; non-valid rows must not claim verification.
  CONSTRAINT user_ai_credentials_valid_verified_check
    CHECK (
      (status = 'valid' AND verified_at IS NOT NULL)
      OR (status <> 'valid' AND verified_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_ai_credentials_unique_provider_purpose
  ON credentials.user_ai_credentials (user_id, provider, purpose);

-- Backfill existing Anthropic BYOK keys into the generic store. Because
-- the encryption envelope is unchanged we copy the existing ciphertext
-- as-is (no decrypt/re-encrypt). Seeds verified status; a key stored
-- on-file was verified at save time.
--
-- Rollback reconciliation (plan.md review F2): during the migration
-- window the LEGACY users.anthropic_key_* columns remain the source of
-- truth for the Anthropic coding-agent credential, because rolled-back
-- (old) code can only ever write those columns. Re-deriving the generic
-- row from legacy on every schema run guarantees rollback survival:
--
--   1. Where legacy ciphertext exists, we OVERWRITE the generic row from
--      it — even if the existing generic row is 'valid'. This reconciles a
--      stale generic key that a legacy-only replace changed during a
--      rollback (a plain `ON CONFLICT DO NOTHING`, or a guard that skips
--      valid rows, would keep the obsolete key usable).
--   2. Where legacy is NULL but a generic row is 'valid', the legacy side
--      (a delete during rollback, or a first-save that was never mirrored)
--      is authoritative: we REVOKE the generic row so a deleted key can
--      never be resurrected. Non-valid generic rows without legacy
--      (e.g. an unverified key kept generic-only) are left as non-usable
--      pending rows.
INSERT INTO credentials.user_ai_credentials
  (user_id, provider, purpose, secret_enc, secret_last4, status, verified_at, revision)
SELECT id, 'anthropic', 'coding_agent', anthropic_key_enc, anthropic_key_last4,
       'valid', NOW(), 1
FROM users
WHERE anthropic_key_enc IS NOT NULL
ON CONFLICT (user_id, provider, purpose) DO UPDATE SET
  secret_enc = EXCLUDED.secret_enc,
  secret_last4 = EXCLUDED.secret_last4,
  secret_fingerprint = NULL,
  status = EXCLUDED.status,
  verified_at = EXCLUDED.verified_at,
  revoked_at = NULL,
  revision = credentials.user_ai_credentials.revision + 1,
  updated_at = NOW()
-- Only touch the generic row when the legacy value actually differs, so
-- we never reset fingerprint / verified_at / revision on an unchanged
-- credential every restart (review F2).
WHERE credentials.user_ai_credentials.secret_enc IS DISTINCT FROM EXCLUDED.secret_enc;

-- Legacy delete must win over a previously-valid generic row: revoke any
-- generic anthropic/coding_agent row that is 'valid' while the legacy
-- column is absent (rolled-back delete, or a key that was never mirrored
-- to legacy). Non-valid rows (unverified/invalid/revoked) are untouched.
UPDATE credentials.user_ai_credentials g
SET secret_enc = NULL,
    secret_last4 = NULL,
    secret_fingerprint = NULL,
    status = 'revoked',
    -- valid_verified requires non-valid rows to carry verified_at NULL,
    -- so the tombstone must clear it or the UPDATE fails (breaking
    -- roll-forward after a rollback deletion).
    verified_at = NULL,
    revoked_at = NOW(),
    revision = g.revision + 1,
    updated_at = NOW()
WHERE g.provider = 'anthropic'
  AND g.purpose = 'coding_agent'
  AND g.status = 'valid'
  AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = g.user_id
      AND u.anthropic_key_enc IS NOT NULL
  );

-- Mark credential-bearing columns for the staging:private scrubber
-- (same treatment the legacy users.anthropic_key_enc already gets).
COMMENT ON TABLE  credentials.user_ai_credentials IS 'staging:private';

-- One company-funded OpenRouter child key reservation per Usernode account.
-- Deployments may optionally require a verified identity before insertion.
-- The row is deliberately retained after remote deletion: its
-- UNIQUE(user_id) tombstone is the durable "issued once" guarantee, while
-- the child secret itself lives only in user_ai_credentials (encrypted).
-- Management keys are deploy secrets and never enter either table.
CREATE TABLE IF NOT EXISTS credentials.managed_openrouter_keys (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  credential_id        BIGINT UNIQUE REFERENCES credentials.user_ai_credentials(id) ON DELETE SET NULL,
  remote_key_hash      VARCHAR(128) UNIQUE,
  remote_label         VARCHAR(255),
  workspace_id         VARCHAR(128),
  status               VARCHAR(24) NOT NULL DEFAULT 'provisioning'
                         CHECK (status IN ('provisioning', 'active', 'disabled',
                                           'deleted', 'needs_review')),
  -- The allowance per reset period. Named for the daily cadence keys were
  -- issued with before #2119; the column keeps that name because renaming it
  -- would need a data migration for nothing, and limit_reset is what labels
  -- it ('weekly' for keys issued under the current policy, 'daily' for
  -- older ones until they are migrated).
  daily_limit_usd      NUMERIC(18,8) NOT NULL CHECK (daily_limit_usd > 0),
  limit_reset          VARCHAR(16) NOT NULL DEFAULT 'daily'
                         CHECK (limit_reset IN ('daily', 'weekly')),
  last_error_code      VARCHAR(64),
  issued_at            TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- #2119: databases created before the weekly policy carry the original
-- CHECK (limit_reset = 'daily') under PostgreSQL's generated name. Replace
-- it by that name on every boot; a fresh database gets the same name from
-- the inline CHECK above, so there this is a no-op.
ALTER TABLE credentials.managed_openrouter_keys
  DROP CONSTRAINT IF EXISTS managed_openrouter_keys_limit_reset_check;
ALTER TABLE credentials.managed_openrouter_keys
  ADD CONSTRAINT managed_openrouter_keys_limit_reset_check
  CHECK (limit_reset IN ('daily', 'weekly'));
CREATE INDEX IF NOT EXISTS managed_openrouter_keys_status_idx
  ON credentials.managed_openrouter_keys (status, updated_at DESC);
COMMENT ON TABLE credentials.managed_openrouter_keys IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Profile customization (issue #982) — the editable half of the #profile
-- screen: a short bio and a profile picture.
-- ═══════════════════════════════════════════════════════════════════════

-- User-authored public bio, shown on the viewer's own #profile screen and
-- (once the follow-up lands) on their public builder page. Plain text, NOT
-- markdown — nothing renders it through marked/DOMPurify, so it is always
-- inserted as a text node. The ≤280-char cap is enforced in
-- src/routes/profile.js rather than as a DB constraint, matching how every
-- other user-authored text column on this table is handled. Deliberately
-- not `staging:private`: it is content the user publishes to other users.
--
-- `display_name`, `github` and `x` — the other three fields the profile
-- editor writes — already exist on this table (topochain Task 2 block
-- above) and are reused as-is; only the bio is new.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Profile pictures, modelled column-for-column on `app_icons` above and
-- served the same way: GET /avatars/:id is mounted BEFORE authMiddleware
-- (src/routes/avatars.js) so a plain <img> renders with no auth dance, and
-- the unguessable 32-hex id is the only access control — an avatar
-- discloses only itself, and it is published to other users by design.
--
-- ONE ROW PER USER (user_id UNIQUE) and the id ROTATES on every upload:
-- POST /api/me/avatar upserts with `ON CONFLICT (user_id) DO UPDATE SET
-- id = EXCLUDED.id, …`, so the content-addressed URL changes whenever the
-- bytes do and the year-long immutable cache header stays safe. That also
-- means there is never an orphan row to sweep (contrast issue_screenshots,
-- which needs the 24h GC) — the UNIQUE + ON DELETE CASCADE cover it.
--
-- NOT staging:private, for the same reason as app_icons: avatars render on
-- shared surfaces and should survive into staging clones.
CREATE TABLE IF NOT EXISTS user_avatars (
  id           VARCHAR(32) PRIMARY KEY,
  user_id      INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type VARCHAR(32) NOT NULL,
  size_bytes   INTEGER     NOT NULL,
  data         BYTEA       NOT NULL,
  sha256       VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public profiles (#582) extend the existing profile customization storage
-- above instead of creating a second display-name/bio/avatar record. Platform
-- username remains the canonical route key; publishing only makes the
-- already-user-authored display_name, bio and user_avatars row readable
-- through the explicit public allowlist in src/routes/profiles.js.
--
-- That key stopped being IMMUTABLE when username changes landed. It is still canonical, and a
-- profile address survives a rename, because the old handle is retired into
-- `username_history` (see the bottom of this file) rather than released and
-- /api/public/profiles/:username resolves through it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_disabled_reason VARCHAR(240);
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

-- Reports are private moderation material. One open report per reporter and
-- profile makes retries idempotent while allowing a later report after the
-- earlier one is resolved or dismissed. Account deletion removes both sides
-- of the identity edge; resolved_by is audit attribution and may become NULL.
CREATE TABLE IF NOT EXISTS profile_reports (
  id               BIGSERIAL PRIMARY KEY,
  profile_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           VARCHAR(32) NOT NULL CHECK (reason IN ('impersonation', 'harassment', 'spam', 'unsafe_avatar', 'other')),
  detail           VARCHAR(500),
  status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_reports_open_reporter
  ON profile_reports (profile_user_id, reporter_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_profile_reports_status_created
  ON profile_reports (status, created_at DESC, id DESC);
COMMENT ON TABLE profile_reports IS 'staging:private';
COMMENT ON COLUMN users.profile_disabled_reason IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Email-based password reset (magic link from the #login recovery screen).
-- ═══════════════════════════════════════════════════════════════════════

-- Single outstanding reset token per user, modelled on wallet_link_token
-- above: the column holds the sha256 hex of a 32-byte token that only ever
-- travels inside the emailed link (/#reset-password?token=…), so a DB read
-- alone can never redeem a reset. Minted by POST
-- /api/auth/password-reset/request only for non-admin accounts with a
-- CONFIRMED email (admins keep the admin-issued temporary-password path —
-- the same email-control-must-not-equal-admin-takeover stance as the
-- web signup guard in src/services/email-signup.js), consumed and
-- cleared by POST /api/auth/password-reset/confirm, which runs
-- accountRecovery() so every session and CLI authorization dies with the
-- old password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN users.password_reset_token_hash IS 'staging:private';
COMMENT ON COLUMN users.password_reset_expires_at IS 'staging:private';

-- ── OpenRouter BYOK with Codex — full feature (plan.md PR3+) ────────
-- All additions are idempotent and live alongside the merged foundation
-- (PR #943: chat_sessions.agent_* + credentials.user_ai_credentials).

-- Per-user per-backend agent preferences (model, reasoning effort, cost
-- ceiling, which backend is the default). One row per (user_id, backend).
CREATE TABLE IF NOT EXISTS user_agent_preferences (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backend            VARCHAR(32) NOT NULL,
  model_id           VARCHAR(255),
  reasoning_effort   VARCHAR(16),
  max_turn_cost_usd  NUMERIC(18,8),
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, backend),
  CONSTRAINT user_agent_preferences_backend_check
    CHECK (backend IN ('claude_code', 'codex_openrouter')),
  CONSTRAINT user_agent_preferences_reasoning_check
    CHECK (reasoning_effort IS NULL
           OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  -- Cost ceiling (review #7): reject negatives at the DB so a buggy client
  -- cannot store a value that disables the cap. The cap is advisory (the
  -- platform does not mediate direct Codex requests), but it must still be
  -- a sane nonnegative number.
  CONSTRAINT user_agent_preferences_cost_check
    CHECK (max_turn_cost_usd IS NULL OR max_turn_cost_usd >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_agent_preferences_one_default
  ON user_agent_preferences (user_id) WHERE is_default = TRUE;

-- Per-model favorite overrides for the otherwise very large OpenRouter
-- catalog. Platform recommendations begin starred when no override exists;
-- storing both TRUE and FALSE is what lets a user keep either choice after
-- the recommendation list changes or the model temporarily leaves the
-- key-filtered catalog. One row per user/model keeps toggles atomic and lets
-- every device see the same list.
CREATE TABLE IF NOT EXISTS user_agent_model_favorites (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backend     VARCHAR(32) NOT NULL,
  model_id    VARCHAR(255) NOT NULL,
  is_favorite BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, backend, model_id),
  CONSTRAINT user_agent_model_favorites_backend_check
    CHECK (backend IN ('codex_openrouter'))
);
ALTER TABLE user_agent_model_favorites
  ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT TRUE;
COMMENT ON TABLE user_agent_model_favorites IS 'staging:private';

-- Durable per-turn ledger for multi-provider usage, retries, and proxy
-- settlement. Idempotent settlement keys on the turn id.
CREATE TABLE IF NOT EXISTS agent_turns (
  id                       UUID PRIMARY KEY,
  session_id               BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backend                  VARCHAR(32) NOT NULL,
  provider                 VARCHAR(32),
  requested_model          VARCHAR(255),
  routed_model             VARCHAR(255),
  routed_provider          VARCHAR(128),
  reasoning_effort         VARCHAR(16),
  credential_id            BIGINT REFERENCES credentials.user_ai_credentials(id),
  credential_revision      INTEGER,
  agent_thread_id          VARCHAR(128),
  agent_config_version     INTEGER NOT NULL DEFAULT 1,
  status                   VARCHAR(24) NOT NULL,
  input_tokens             BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_write_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens            BIGINT NOT NULL DEFAULT 0,
  reasoning_output_tokens  BIGINT NOT NULL DEFAULT 0,
  actual_cost_usd          NUMERIC(18,8) NOT NULL DEFAULT 0,
  estimated_cost_usd       NUMERIC(18,8),
  cost_source              VARCHAR(32),
  billed_by                VARCHAR(32),
  logical_turn_id          UUID,
  attempt_number           INTEGER NOT NULL DEFAULT 1,
  provider_input_tokens_total          BIGINT,
  provider_cached_input_tokens_total   BIGINT,
  provider_cache_write_input_tokens_total BIGINT,
  provider_output_tokens_total         BIGINT,
  provider_reasoning_output_tokens_total BIGINT,
  usage_reset_detected     BOOLEAN NOT NULL DEFAULT FALSE,
  error_code               VARCHAR(64),
  error_detail             TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  metadata                 JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_turns_session
  ON agent_turns (session_id, started_at);
-- Idempotent upgrade (review P7): an environment that already applied a
-- preceding PR revision has agent_turns without agent_config_version, and
-- CREATE TABLE IF NOT EXISTS is a no-op there. This ALTER covers that path.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS agent_config_version INTEGER NOT NULL DEFAULT 1;
-- Commit 4 (plan §6): per-attempt + cumulative provider totals.
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS logical_turn_id UUID;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS cache_write_input_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_cached_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_cache_write_input_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_output_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS provider_reasoning_output_tokens_total BIGINT;
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(18,8);
ALTER TABLE agent_turns ADD COLUMN IF NOT EXISTS usage_reset_detected BOOLEAN NOT NULL DEFAULT FALSE;
-- Backfill legacy single-turn rows: a lone row IS its own logical turn.
UPDATE agent_turns SET logical_turn_id = id WHERE logical_turn_id IS NULL AND attempt_number = 1;
-- One physical Codex invocation = one attempt under a logical turn.
CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_logical_attempt_unique
  ON agent_turns (logical_turn_id, attempt_number)
  WHERE logical_turn_id IS NOT NULL;

-- Durable idempotency receipts for replayable post-agent work. A platform
-- restart may re-enter a turn tail, but a stable (turn_id, effect_key) means
-- database-local effects (spend settlement, cards, notifications, terminal
-- state) can be committed exactly once in the same transaction as the
-- receipt. External effects use pending/completed plus reconciliation.
CREATE TABLE IF NOT EXISTS turn_effects (
  turn_id       UUID NOT NULL,
  effect_key    VARCHAR(96) NOT NULL,
  session_id    BIGINT REFERENCES chat_sessions(id) ON DELETE CASCADE,
  state         VARCHAR(16) NOT NULL DEFAULT 'pending',
  result        JSONB,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (turn_id, effect_key),
  CONSTRAINT turn_effects_state_check
    CHECK (state IN ('pending', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_turn_effects_session
  ON turn_effects (session_id, started_at);
-- Nonnegativity (idempotent DO blocks; an already-created table will not
-- pick up constraints from CREATE TABLE IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_turns_provider_totals_nonneg') THEN
    ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_provider_totals_nonneg CHECK (
      provider_input_tokens_total IS NULL OR provider_input_tokens_total >= 0
    );
  END IF;
END$$;

-- Compatibility overlay: verified / experimental / blocked per model.
CREATE TABLE IF NOT EXISTS agent_model_compatibility (
  backend             VARCHAR(32) NOT NULL,
  model_id            VARCHAR(255) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  minimum_cli_version VARCHAR(32),
  note                TEXT,
  checked_at          TIMESTAMPTZ,
  PRIMARY KEY (backend, model_id)
);

-- Seed a verified Codex model as the recommended first-run choice.
-- Compatibility is advisory: every model in the user's OpenRouter catalog
-- remains selectable, while operators can mark known-good models here.
INSERT INTO agent_model_compatibility (backend, model_id, status, note, checked_at)
VALUES ('codex_openrouter', 'openai/gpt-5.3-codex', 'verified', 'Default verified Codex model', NOW())
ON CONFLICT (backend, model_id) DO NOTHING;

-- The OpenRouter model catalog, one copy for the whole platform
-- (services/agent-models.js): OpenRouter's public GET /models, refreshed in
-- the background. Kept here so every pod, a fresh deploy included, answers a
-- model menu from it at once instead of asking OpenRouter while it waits.
-- One row; `models` is OpenRouter's own list, less the descriptions.
CREATE TABLE IF NOT EXISTS openrouter_model_catalog (
  id         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  models     JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

-- AI-generated progress report cache (Reporting tab). One row per app —
-- the summary is shared by every viewer, which is why its input is built
-- exclusively from data every app member can see (no private sessions).
-- input_hash fingerprints the server-built input so an unchanged app
-- returns the cache without an LLM call and the client can show a
-- "data changed" staleness hint.
CREATE TABLE IF NOT EXISTS app_report_ai (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  input_hash    VARCHAR(64) NOT NULL,
  narrative     TEXT NOT NULL,
  risks_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
  owners_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  model         VARCHAR(64),
  generated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bullet-point progress highlights for the AI report summary
-- (report-lock-share). Additive to the existing app_report_ai row; old
-- rows default to an empty list and render without the section.
ALTER TABLE app_report_ai ADD COLUMN IF NOT EXISTS highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Report period start (reporting-period). The start date the cached
-- summary was generated for — NULL means "all history". The cache is one
-- shared row per app, so recording the period keeps the summary honest
-- about what it covers when members select different periods.
ALTER TABLE app_report_ai ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ;

-- Locked report snapshots (report-lock-share). Locking freezes the
-- client's self-contained standalone report document as an immutable
-- dated row; the draft cache above keeps being overwritten. html is
-- untrusted user content and is only ever served under a sandbox CSP.
-- ai_json is the SERVER's own draft summary at lock time — it feeds the
-- next generation's "previousReport" input, so it must never come from
-- the client. share_token (32-hex, crypto-random) is the sole access
-- control on the public /reports/:token route; NULL means not shared,
-- and unsharing nulls it again so revoked links 404.
CREATE TABLE IF NOT EXISTS app_report_snapshots (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  html         TEXT NOT NULL,
  ai_json      JSONB,
  locked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  share_token  VARCHAR(64) UNIQUE,
  shared_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_report_snapshots_app
  ON app_report_snapshots (app_id, locked_at DESC);

-- Workshop themes cache (the Dev screen's lander). One row per app, shared
-- by every viewer — the input is built from shared-visibility data only,
-- exactly like app_report_ai above. themes_json is the model's grouping:
-- [{ id, name, description, saying, items: ['issue:12', 'session:34', …] }]
-- with STABLE ids (the previous themes are fed back into each run so a
-- theme keeps its id across regenerations). input_hash fingerprints the
-- board the grouping was made from; a stale row is served as is while a
-- regeneration runs behind the request. `source` is 'ai' for every cached
-- row — the no-model category grouping is computed per request and never
-- written here, so a key arriving later takes over cleanly.
CREATE TABLE IF NOT EXISTS app_workshop_themes (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  input_hash    VARCHAR(64) NOT NULL,
  themes_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
  source        VARCHAR(16) NOT NULL DEFAULT 'ai',
  model         VARCHAR(64),
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The grouping became a two-stage pipeline (services/workshop-themes.js):
-- themes_json now holds theme DEFINITIONS only ([{ id, name, description,
-- saying, anchors }]) and placements_json the card → theme id map they are
-- served with, so a card the model skipped is retried, never lost. Rows
-- written before this carry `items` on the definitions and serve from them
-- until the first reconcile. input_hash became the key set's digest.
--   unplaced_json        cards the placer said fit no theme (they count as churn)
--   discovered_at        when the definitions were last drafted
--   discovery_key_count  how many cards that draft covered (the drift base)
--   churn_added/removed  cards added / gone since that draft; a tenth re-drafts
--   last_error/failed_at the last failed stage, for the footnote and the backoff
--   last_viewed_at       stamped by GET; the hourly sweep re-checks recent apps
--   reconcile_started_at the cross-instance lease one reconcile holds
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS placements_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS unplaced_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS discovery_key_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS churn_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS churn_removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS reconcile_started_at TIMESTAMPTZ;
-- The Workshop's status paragraph: two sentences on the week just gone and
-- what is in flight, written by the same model that drafts the themes, from
-- the same snapshot, on the same reconcile. Kept HERE rather than in its own
-- table so it can never describe a board the themes beside it were not
-- drafted against. Empty when no model is configured or the call failed: the
-- client falls back to a sentence derived from the counts.
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS digest_text TEXT;
-- The same answer as three windowed one-line fields — { lastWeek, thisWeek,
-- open } — which is what the lander draws, as three cards under the number
-- tiles. digest_text above is kept as the flattened prose form: it is what a
-- row written under digest prompt version 2 holds, and the fields here cannot
-- be recovered from it, so a v2 row serves its paragraph until the version
-- bump re-asks the model. An empty string in a field means that window was
-- genuinely empty and its card is not drawn.
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS digest_json JSONB;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS digest_at TIMESTAMPTZ;
-- Why the last digest attempt got nothing, or NULL when it succeeded. Read by
-- the lander's footnote, and it picks the retry window (an hour after a
-- failure, a day after a success).
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS digest_error TEXT;
-- Which version of each stage's prompt the row was last produced by: the
-- WORKSHOP_*_VERSION constants beside the prompts in services/llm.js. A
-- bump makes that stage due on the app's next pass whatever its clocks say
-- (discovery re-drafts, placement re-places every card, the digest is
-- rewritten). Stamped on the ATTEMPT, like digest_at, so a bump against a
-- failing model keeps its backoff instead of retrying on every view. The
-- default grandfathers the rows written before the columns existed: a
-- deploy re-drafts nothing by itself.
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS discovery_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS placement_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_workshop_themes ADD COLUMN IF NOT EXISTS digest_version INTEGER NOT NULL DEFAULT 1;

-- The hub's since-your-last-visit line (services/since-summary.js). One row
-- per app per WINDOW, shared by every viewer whose last visit falls in it:
-- a visit is floored to a six-hour block within the last day, to its UTC
-- day within two weeks, and to two weeks ago before that, so a project has
-- about twenty live windows whoever is visiting. Built from merged changes
-- only, which every viewer of the app may see, exactly like
-- app_workshop_themes above. head_at is the newest change the line was
-- written for; a newer merge makes it stale, and a stale line is served as
-- is while it is rewritten behind the request, at most once an hour.
--   summary      the one or two sentences (Claude Sonnet 5.5)
--   error        the last failed attempt, for the hourly retry backoff
--   version      llm.SINCE_SUMMARY_VERSION the line was written under
-- Rows for windows older than the longest one are dropped on write.
CREATE TABLE IF NOT EXISTS app_since_summaries (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  window_start  TIMESTAMPTZ NOT NULL,
  head_at       TIMESTAMPTZ NOT NULL,
  change_count  INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  error         TEXT,
  model         VARCHAR(64),
  version       INTEGER NOT NULL DEFAULT 1,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, window_start)
);

-- Platform-wide private messaging (#488). This domain is deliberately
-- separate from app-scoped `chat_messages`: membership, consent, blocks,
-- retention, and realtime audiences are all platform-user concerns.
CREATE TABLE IF NOT EXISTS conversations (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(16) NOT NULL CHECK (kind IN ('direct', 'group')),
  title      VARCHAR(80),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status     VARCHAR(16) NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'direct' AND title IS NULL)
    OR (kind = 'group' AND title IS NOT NULL AND BTRIM(title) <> '')
  )
);

-- Direct conversations have one canonical unordered user pair. The service
-- also takes a transaction-scoped advisory lock on the normalized pair;
-- this unique constraint is the final race-proof backstop.
CREATE TABLE IF NOT EXISTS conversation_direct_pairs (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_low_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  CHECK (user_low_id < user_high_id),
  UNIQUE (user_low_id, user_high_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                VARCHAR(16) NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner', 'member')),
  status              VARCHAR(16) NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'member', 'declined', 'left', 'removed')),
  invited_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at        TIMESTAMPTZ,
  joined_at           TIMESTAMPTZ,
  left_at             TIMESTAMPTZ,
  last_read_message_id INTEGER,
  PRIMARY KEY (conversation_id, user_id),
  CHECK (role <> 'owner' OR status IN ('member', 'left', 'removed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_members_active_owner
  ON conversation_members (conversation_id)
  WHERE role = 'owner' AND status = 'member';
CREATE INDEX IF NOT EXISTS idx_conversation_members_user_active
  ON conversation_members (user_id, conversation_id)
  WHERE status IN ('member', 'invited');

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content         TEXT NOT NULL DEFAULT '',
  msg_type        VARCHAR(24) NOT NULL DEFAULT 'message'
                    CHECK (msg_type IN ('message', 'system')),
  reply_to_id     INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  idempotency_key VARCHAR(64),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  CHECK (char_length(content) <= 8000)
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_page
  ON conversation_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_reply
  ON conversation_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_idempotency
  ON conversation_messages (conversation_id, sender_id, idempotency_key)
  WHERE sender_id IS NOT NULL AND idempotency_key IS NOT NULL;

-- ── Messages overhaul (#2387): soft delete and threads ─────────────────
-- `deleted_at` marks an author's own soft delete. The row stays (so thread
-- replies, quotes and read cursors that point at it keep resolving) and is
-- served as a placeholder: services/conversations.js clears the content and
-- removes its attachments, cards, reactions, saves and notifications in the
-- same transaction that stamps this column.
--
-- `thread_root_id` files a reply under a main-stream message of the same
-- conversation (group or channel; never direct, never nested — the service
-- enforces both). NULL is the main stream, which is all that the transcript,
-- unread counts and the list's latest message read. CASCADE rather than SET
-- NULL: a thread is never re-parented into the main stream, and roots are
-- only ever soft-deleted, so the cascade fires only with the conversation.
-- Both columns inherit conversation_messages' table-level staging:private
-- tag, and neither references users, so account deletion is unaffected.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS thread_root_id INTEGER
  REFERENCES conversation_messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread
  ON conversation_messages (thread_root_id, id) WHERE thread_root_id IS NOT NULL;
-- ── end messages overhaul (#2387) ──────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_members'::regclass
       AND conname = 'conversation_members_last_read_message_id_fkey'
  ) THEN
    ALTER TABLE conversation_members
      ADD CONSTRAINT conversation_members_last_read_message_id_fkey
      FOREIGN KEY (last_read_message_id)
      REFERENCES conversation_messages(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_message_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL CHECK (BTRIM(emoji) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_conversation_reactions_message
  ON conversation_message_reactions (message_id);

-- Personal saves on a DIRECT/GROUP conversation message — the Messages-area
-- half of the bookmark that app group chat has carried since #1280.
--
-- It is a second table rather than a widened `message_bookmarks` because that
-- one's `message_id` is a foreign key into `chat_messages`, and a DM is a row
-- of `conversation_messages`. One column cannot reference two tables, and the
-- alternatives — dropping the FK for a soft (kind, id) pair, or a shared
-- supertype — would trade a constraint the database enforces for one the
-- application would have to remember. Two narrow tables, one service
-- (src/services/message-bookmarks.js) reading both, one section rendering the
-- union.
--
-- Same shape and the same reasoning as `message_bookmarks`: one row per
-- (user, message), the UNIQUE constraint is what makes saving an idempotent
-- upsert, and `staging:private` because it is one person's private feed that
-- a staging clone must not carry.
CREATE TABLE IF NOT EXISTS conversation_message_bookmarks (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, message_id)
);
-- "This user's saves, newest first" — the section's only read order.
CREATE INDEX IF NOT EXISTS conversation_message_bookmarks_user_idx
  ON conversation_message_bookmarks (user_id, created_at DESC);

-- Upload-before-send, like app group chat. Unlinked rows remain readable
-- only to their uploader and are eligible for orphan collection after 24h.
CREATE TABLE IF NOT EXISTS conversation_message_attachments (
  id              VARCHAR(32) PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            VARCHAR(16) NOT NULL
                    CHECK (kind IN ('image', 'markdown', 'html', 'text', 'binary')),
  filename        VARCHAR(256) NOT NULL,
  content_type    VARCHAR(128) NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
  meta            JSONB,
  data            BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_message
  ON conversation_message_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_orphan
  ON conversation_message_attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_attachments_storage
  ON conversation_message_attachments (conversation_id, user_id);

-- Repair any database that applied an earlier draft where deleting the
-- uploader cascaded linked attachment evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'conversation_message_attachments'::regclass
       AND attname = 'user_id' AND attnotnull
  ) THEN
    ALTER TABLE conversation_message_attachments ALTER COLUMN user_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_attachments'::regclass
       AND conname = 'conversation_message_attachments_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_attachments
      DROP CONSTRAINT conversation_message_attachments_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_attachments'::regclass
       AND conname = 'conversation_message_attachments_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_attachments
      ADD CONSTRAINT conversation_message_attachments_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One typed, canonical platform-object reference per message. Display fields
-- are never stored here: hydration derives them through the viewer's current
-- authorization and returns one generic unavailable shape on any denial.
CREATE TABLE IF NOT EXISTS conversation_message_objects (
  id             SERIAL PRIMARY KEY,
  message_id     INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  position       SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0 AND position < 8),
  object_type    VARCHAR(24) NOT NULL CHECK (object_type IN (
                   'app', 'github_issue', 'code_proposal',
                   'governance_proposal', 'spec'
                 )),
  app_id         INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  object_ref     INTEGER NOT NULL CHECK (object_ref > 0),
  object_version INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (object_type = 'spec' AND object_version IS NOT NULL AND object_version > 0)
    OR (object_type <> 'spec' AND object_version IS NULL)
  ),
  CHECK (object_type <> 'app' OR app_id IS NULL OR object_ref = app_id),
  UNIQUE (message_id, position)
);
CREATE INDEX IF NOT EXISTS idx_conversation_objects_message
  ON conversation_message_objects (message_id, position);
CREATE INDEX IF NOT EXISTS idx_conversation_objects_app
  ON conversation_message_objects (app_id, object_type, object_ref);

-- Staging's old /messages/91000x links name recipes, not shared private
-- conversations. Each viewer gets separate persisted rows; every subsequent
-- action uses the ordinary conversation/message IDs and permission checks.
CREATE TABLE IF NOT EXISTS staging_conversation_fixtures (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  legacy_id INTEGER NOT NULL CHECK (legacy_id BETWEEN 910001 AND 910004),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, legacy_id)
);
COMMENT ON TABLE staging_conversation_fixtures IS 'staging:private';
-- #3624: a fifth address, 910005, for the Homeroom bot's DM with a question
-- open (services/staging-messages.js ensureBotDmFixture). Widening a CHECK
-- rejects no row already stored.
DO $$
BEGIN
  ALTER TABLE staging_conversation_fixtures DROP CONSTRAINT IF EXISTS staging_conversation_fixtures_legacy_id_check;
  ALTER TABLE staging_conversation_fixtures ADD CONSTRAINT staging_conversation_fixtures_legacy_id_check
    CHECK (legacy_id BETWEEN 910001 AND 910005);
END $$;

CREATE TABLE IF NOT EXISTS staging_app_fixtures (
  app_id INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE
);
COMMENT ON TABLE staging_app_fixtures IS 'staging:private';
ALTER TABLE staging_app_fixtures
  ADD COLUMN IF NOT EXISTS home_favorite_seeded BOOLEAN NOT NULL DEFAULT FALSE;

-- Sharing an exact immutable spec version into a conversation grants it to
-- current members. Membership is checked at every read, so leaving/removal
-- immediately revokes both retained-history and full-spec access.
CREATE TABLE IF NOT EXISTS chat_session_spec_conversation_shares (
  session_id      INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  shared_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, version, conversation_id),
  FOREIGN KEY (session_id, version)
    REFERENCES chat_session_specs(session_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spec_conversation_shares_conversation
  ON chat_session_spec_conversation_shares (conversation_id, created_at DESC);

-- Blocks are global and directional. Either direction prevents a new direct
-- request, direct acceptance/sending, and a new group invitation; an existing
-- shared group is intentionally not disrupted or used to reveal block state.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_user_id),
  CHECK (blocker_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked
  ON user_blocks (blocked_user_id, blocker_id);

-- Reports retain immutable evidence even when the author later edits the
-- live message. One pending report per reporter/message makes retries safe.
CREATE TABLE IF NOT EXISTS conversation_message_reports (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id        INTEGER NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  reporter_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason            VARCHAR(32) NOT NULL CHECK (reason IN (
                      'harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other'
                    )),
  detail            VARCHAR(500),
  content_snapshot  TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_reports_pending
  ON conversation_message_reports (message_id, reporter_user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_conversation_reports_queue
  ON conversation_message_reports (status, created_at DESC, id DESC);

-- Reports retain their evidence when a mini-app or discussion post is later
-- deleted. A pending report is unique per reporter and live target.
CREATE TABLE IF NOT EXISTS app_reports (
  id                BIGSERIAL PRIMARY KEY,
  app_id            INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  reporter_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_slug_snapshot VARCHAR(255) NOT NULL,
  app_name_snapshot VARCHAR(255) NOT NULL,
  reason            VARCHAR(32) NOT NULL CHECK (reason IN ('spam', 'harassment', 'unsafe_content', 'impersonation', 'other')),
  detail            VARCHAR(500),
  status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_reports_pending
  ON app_reports (app_id, reporter_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_app_reports_queue
  ON app_reports (status, created_at DESC, id DESC);
COMMENT ON TABLE app_reports IS 'staging:private';

CREATE TABLE IF NOT EXISTS chat_message_reports (
  id                BIGSERIAL PRIMARY KEY,
  app_id            INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  message_id        INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  reporter_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_slug_snapshot VARCHAR(255) NOT NULL,
  reason            VARCHAR(32) NOT NULL CHECK (reason IN ('harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other')),
  detail            VARCHAR(500),
  content_snapshot  TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_reports_pending
  ON chat_message_reports (message_id, reporter_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_chat_message_reports_queue
  ON chat_message_reports (status, created_at DESC, id DESC);
COMMENT ON TABLE chat_message_reports IS 'staging:private';

-- Repair earlier drafts for immutable abuse evidence as well: account
-- deletion removes attribution, never the retained report snapshot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'conversation_message_reports'::regclass
       AND attname IN ('reporter_user_id', 'reported_user_id') AND attnotnull
  ) THEN
    ALTER TABLE conversation_message_reports ALTER COLUMN reporter_user_id DROP NOT NULL;
    ALTER TABLE conversation_message_reports ALTER COLUMN reported_user_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reporter_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_reports
      DROP CONSTRAINT conversation_message_reports_reporter_user_id_fkey;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reported_user_id_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE conversation_message_reports
      DROP CONSTRAINT conversation_message_reports_reported_user_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reporter_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_reports
      ADD CONSTRAINT conversation_message_reports_reporter_user_id_fkey
      FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'conversation_message_reports'::regclass
       AND conname = 'conversation_message_reports_reported_user_id_fkey'
  ) THEN
    ALTER TABLE conversation_message_reports
      ADD CONSTRAINT conversation_message_reports_reported_user_id_fkey
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Conversation notifications coexist with app-chat notifications. Dedicated
-- kinds avoid app routing/category collisions; both references remain nullable
-- for every pre-existing notification kind.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_id
  INTEGER REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_message_id
  INTEGER REFERENCES conversation_messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_conversation
  ON notifications (conversation_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_conversation_message
  ON notifications (conversation_message_id);
-- #2783: CHANNELS. A third conversation kind for a room EVERY signed-in user
-- is in and can post to — today exactly one, #general. It lives in this
-- domain rather than in app-scoped `chat_messages` because it belongs to no
-- app, and because this domain already carries everything a shared room
-- needs: replies, reactions, edits, attachments, per-viewer read cursors,
-- saves, reports and the realtime audience.
--
-- Membership is IMPLICIT: services/conversations.js joins a viewer the first
-- time their conversation list is read, so the room never needs an invite
-- and nobody is fanned out to until they have opened Messages. A channel has
-- no owner and cannot be left, renamed or managed by its members.
--
-- `channel_key` is the room's stable handle (`general`), the thing a `#name`
-- reference in a message resolves against. The CHECKs are re-stated under
-- names here because CREATE TABLE IF NOT EXISTS above skips an existing
-- table: the unnamed originals (`conversations_kind_check`, and the table
-- CHECK Postgres names `conversations_check`) only allowed two kinds.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_key VARCHAR(40);
DO $$
BEGIN
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
  ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
    CHECK (kind IN ('direct', 'group', 'channel'));
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_check;
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_title_check;
  ALTER TABLE conversations ADD CONSTRAINT conversations_title_check CHECK (
    (kind = 'direct' AND title IS NULL)
    OR (kind IN ('group', 'channel') AND title IS NOT NULL AND BTRIM(title) <> '')
  );
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_key_check;
  ALTER TABLE conversations ADD CONSTRAINT conversations_channel_key_check
    CHECK ((kind = 'channel') = (channel_key IS NOT NULL));
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_key
  ON conversations (channel_key) WHERE channel_key IS NOT NULL;
-- The room itself, in production and staging alike: it is the platform's,
-- not demo data. `conversations` is staging:private, so a fresh staging
-- clone starts without it and this line puts it back.
INSERT INTO conversations (kind, title, channel_key)
VALUES ('channel', 'general', 'general')
ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_notifications_user_conversation_unread
  ON notifications (user_id, conversation_id, created_at DESC)
  WHERE read_at IS NULL AND conversation_id IS NOT NULL;

COMMENT ON TABLE conversations IS 'staging:private';
COMMENT ON TABLE conversation_message_bookmarks IS 'staging:private';
COMMENT ON TABLE conversation_direct_pairs IS 'staging:private';
COMMENT ON TABLE conversation_members IS 'staging:private';
COMMENT ON TABLE conversation_messages IS 'staging:private';
COMMENT ON TABLE conversation_message_reactions IS 'staging:private';
COMMENT ON TABLE conversation_message_attachments IS 'staging:private';
COMMENT ON TABLE conversation_message_objects IS 'staging:private';
COMMENT ON TABLE chat_session_spec_conversation_shares IS 'staging:private';
COMMENT ON TABLE user_blocks IS 'staging:private';
COMMENT ON TABLE conversation_message_reports IS 'staging:private';

-- Account deletion must not strand a group without an owner or erase retained
-- conversation history. This centralized BEFORE DELETE trigger covers every
-- admin/account-deletion path before participant FKs cascade: group ownership
-- moves deterministically to the oldest active member, empty groups and all
-- direct conversations are archived, and linked attachment/report evidence
-- keeps its content with nullable attribution.
CREATE OR REPLACE FUNCTION prepare_conversations_for_user_exit(p_user_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  owned RECORD;
  successor_id INTEGER;
BEGIN
  -- Unsent uploads have no retained conversation evidence. Remove those
  -- immediately; linked bytes keep their row and lose only attribution via
  -- the nullable ON DELETE SET NULL foreign key below.
  DELETE FROM conversation_message_attachments
   WHERE user_id = p_user_id AND message_id IS NULL;

  FOR owned IN
    SELECT c.id
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.kind = 'group' AND c.status = 'active'
       AND cm.user_id = p_user_id AND cm.status = 'member' AND cm.role = 'owner'
     FOR UPDATE OF c, cm
  LOOP
    SELECT cm.user_id INTO successor_id
      FROM conversation_members cm
     WHERE cm.conversation_id = owned.id
       AND cm.user_id <> p_user_id AND cm.status = 'member'
     ORDER BY cm.joined_at NULLS LAST, cm.created_at, cm.user_id
     LIMIT 1
     FOR UPDATE;

    UPDATE conversation_members
       SET role = 'member', status = 'removed', left_at = NOW()
     WHERE conversation_id = owned.id AND user_id = p_user_id;

    IF successor_id IS NULL THEN
      UPDATE conversation_members
         SET status = 'declined', responded_at = NOW()
       WHERE conversation_id = owned.id AND status = 'invited';
      DELETE FROM notifications WHERE conversation_id = owned.id;
      UPDATE conversations SET status = 'archived', updated_at = NOW()
       WHERE id = owned.id;
    ELSE
      UPDATE conversation_members SET role = 'owner'
       WHERE conversation_id = owned.id AND user_id = successor_id;
      UPDATE conversations SET updated_at = NOW() WHERE id = owned.id;
    END IF;
  END LOOP;

  UPDATE conversations c
     SET status = 'archived', updated_at = NOW()
   WHERE c.kind = 'direct' AND c.status = 'active'
     AND EXISTS (
       SELECT 1 FROM conversation_direct_pairs p
        WHERE p.conversation_id = c.id
          AND (p.user_low_id = p_user_id OR p.user_high_id = p_user_id)
     );
  DELETE FROM notifications n
   USING conversation_direct_pairs p
   WHERE n.conversation_id = p.conversation_id
     AND (p.user_low_id = p_user_id OR p.user_high_id = p_user_id);
END;
$$;

-- Account anonymisation (account-deletion.js) keeps the users row, so no
-- DELETE fires; it calls prepare_conversations_for_user_exit directly.
CREATE OR REPLACE FUNCTION prepare_conversations_for_user_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM prepare_conversations_for_user_exit(OLD.id);
  RETURN OLD;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_prepare_conversations_for_delete'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_prepare_conversations_for_delete
      BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION prepare_conversations_for_user_delete();
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Mutual friends (#2386).
-- ═══════════════════════════════════════════════════════════════════════
--
-- ONE ROW PER UNORDERED PAIR, normalised exactly like
-- conversation_direct_pairs (user_low_id < user_high_id). A pair therefore
-- can never hold two requests, or a request beside a friendship: the row IS
-- the relationship, and `status` says which one it is.
--
--   pending  — `requester_id` asked; the other person sees an incoming request.
--   declined — the other person said no. SILENTLY: the requester keeps seeing
--              "Requested" (and may cancel it), the recipient sees nothing.
--   accepted — friends, in both directions.
--
-- src/services/friends.js takes the same normalised pair advisory lock as a
-- direct message and a block (`conversation-direct:<low>:<high>`) before it
-- touches a row, so a request, an accept and a block on one pair serialise,
-- and conversations.setBlock deletes the pair's row inside its own
-- transaction. A friends list is readable only by its owner; nothing here is
-- counted or published.
--
-- Account deletion: every reference CASCADEs. There is nothing to retain — a
-- relationship with nobody on the other end of it is not history — and the
-- friend notifications the deleted person sent go with the rest of their
-- `source_user_id` rows in services/account-deletion.js.
CREATE TABLE IF NOT EXISTS friendships (
  user_low_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'declined', 'accepted')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id),
  CHECK (requester_id IN (user_low_id, user_high_id))
);
-- The primary key answers "the pair"; a person's own lists read the pair
-- from either side, and the pending-outgoing cap counts one requester's
-- open rows (a declined one still looks open to its sender, so it counts).
CREATE INDEX IF NOT EXISTS idx_friendships_high
  ON friendships (user_high_id, user_low_id);
CREATE INDEX IF NOT EXISTS idx_friendships_requester_open
  ON friendships (requester_id) WHERE status IN ('pending', 'declined');

-- The rolling-day send cap (50 requests a day) needs a ledger that a cancel
-- cannot erase, or cancel-and-resend would reset it. One row per request
-- actually sent; the service prunes a requester's rows older than a day on
-- each send, so the table stays at most a day deep per person.
CREATE TABLE IF NOT EXISTS friend_request_sends (
  id           BIGSERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_friend_request_sends_requester
  ON friend_request_sends (requester_id, created_at DESC);

-- A decline's 30-day quiet period, kept apart from `friendships` because it
-- must outlive the request row: a requester who cancels a declined request
-- and sends it again gets an ordinary "Requested" back, but the recipient is
-- neither notified nor shown it until the period is over. Keyed by direction
-- — it protects the person who declined, from the person they declined.
CREATE TABLE IF NOT EXISTS friend_request_declines (
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  declined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recipient_id, requester_id),
  CHECK (recipient_id <> requester_id)
);

COMMENT ON TABLE friendships IS 'staging:private';
COMMENT ON TABLE friend_request_sends IS 'staging:private';
COMMENT ON TABLE friend_request_declines IS 'staging:private';

-- ═══════════════════════════════════════════════════════════════════════
-- Username changes — the retired-handle ledger.
-- ═══════════════════════════════════════════════════════════════════════
--
-- `users.username` used to be immutable, and src/routes/profile.js said so
-- in its header. What made it immutable was never the login (sessions key
-- on user_id, so a rename doesn't sign anyone out) — it was that FOUR
-- surfaces resolve a person by their handle STRING, from data the platform
-- does not own:
--
--   1. `@name` in historical chat text (src/services/notifications.js).
--   2. `#leaderboard/users/<name>` links people have already shared.
--   3. `admins: [...]` in each app repo's dapp.json, which the platform
--      re-resolves on every deploy (src/services/app-manifest.js) and
--      cannot rewrite — it lives in somebody else's repository.
--   4. `/api/public/profiles/<name>`, the public profile address.
--
-- Free the old handle and all four silently re-point at whoever registers
-- it next; #3 hands them app-admin rights. So a rename RETIRES the old
-- handle permanently instead: one row here per rename, and every one of
-- those four resolvers consults this table alongside `users`. Nobody can
-- register a retired handle, and it keeps resolving to the person who
-- gave it up. The namespace only ever shrinks, which is why the rename
-- itself is rate-limited (RENAME_COOLDOWN_DAYS in src/services/usernames.js).
--
-- `username` is the RETIRED name and is globally unique — two people can
-- never have given up the same handle, because holding it was already
-- exclusive. `user_id` is ON DELETE CASCADE, not SET NULL: once the
-- account is gone there is nobody left to resolve to, and a deleted user's
-- old handles should return to the pool rather than be tombstoned forever
-- (contrast db_exports.username, which is an audit snapshot and survives
-- deletion on purpose).
--
-- NOT staging:private — these are public handles, on the same tier as
-- `users.username` itself, and the resolvers above must work in a staging
-- clone or a preview would 404 on links production serves fine.
CREATE TABLE IF NOT EXISTS username_history (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username    VARCHAR(255) NOT NULL,
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The reservation itself. Case-insensitive because every handle resolver
-- on the platform matches with LOWER(username) — a unique index on the raw
-- string would let "Alice" be registered after "alice" was retired, which
-- is exactly the impersonation this table exists to stop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_username_history_lower
  ON username_history (LOWER(username));
-- Backs the cooldown check and the "your previous handles" read, both of
-- which want this user's most recent rename first.
CREATE INDEX IF NOT EXISTS idx_username_history_user
  ON username_history (user_id, changed_at DESC);

-- The reservation has to be enforced in the DATABASE, not in the routes.
-- Six different code paths insert into `users` (activation-code register,
-- wallet register, the two topochain admin creates, web email signup and
-- fleet-maintenance), none of them share a validator, and a seventh will be
-- added by someone who has never read this file. A handle escaping through
-- any one of them is the exact failure `username_history` exists to
-- prevent: the new holder inherits every historical `@mention`, every
-- shared profile link, and — through dapp.json's `admins` block — app-admin
-- rights on somebody else's app.
--
-- Raised as unique_violation (23505) ON PURPOSE. Every one of those routes
-- already catches 23505 from the `users.username` unique index and answers
-- "Username already taken", so a retired handle produces the right 409 with
-- no route change and no route able to opt out. It also keeps the two
-- states indistinguishable to a caller probing the namespace, which is the
-- same reason checkAvailability in src/services/usernames.js returns one
-- sentence for both.
--
-- Scoped to INSERT and to an actual username CHANGE on UPDATE, so ordinary
-- writes to other columns never pay for the lookup. `user_id <> NEW.id` is
-- what lets someone take BACK a handle they retired earlier: the
-- reservation is against other people, not against changing your mind.
CREATE OR REPLACE FUNCTION reject_retired_username() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM username_history h
     WHERE LOWER(h.username) = LOWER(NEW.username)
       AND h.user_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'username % is retired', NEW.username
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_reject_retired_username'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_reject_retired_username
      BEFORE INSERT OR UPDATE OF username ON users
      FOR EACH ROW EXECUTE FUNCTION reject_retired_username();
  END IF;
END $$;

-- Usernames are unique CASE-INSENSITIVELY (#2296). `users.username` is only
-- UNIQUE on the raw string, so "Drea" could be registered while "drea"
-- existed — yet every resolver matches LOWER(username) (see
-- idx_users_username_lower above), so the two then fight over one @mention,
-- one profile address and one dapp.json `admins` entry. A rename already
-- refused this (checkAvailability in src/services/usernames.js); the two
-- registration routes did not.
--
-- A trigger, not a UNIQUE index on LOWER(username), because production
-- already holds case-variant pairs from before this existed: building that
-- index would fail at boot, and picking a winner between two real accounts
-- is not something a migration may decide. The trigger enforces the rule on
-- every NEW insert and rename and leaves the legacy pairs to be resolved by
-- hand. Same ERRCODE contract as reject_retired_username: every route's
-- existing 23505 handler answers "Username already taken" unchanged.
--
-- The transaction-scoped advisory lock, keyed on the lowered name, is what
-- makes a check-then-insert safe: two concurrent registrations of "drea"
-- and "Drea" serialise on it, and the second one's EXISTS runs after the
-- first has committed. `u.id <> NEW.id` lets a user change the case of
-- their own handle.
--
-- `u.username <> NEW.username` leaves an EXACT match to the raw UNIQUE
-- constraint. A BEFORE trigger fires before ON CONFLICT is considered, so
-- without it the idempotent seeds (`INSERT … ON CONFLICT (username) DO
-- NOTHING`, run on every boot in src/db/migrate.js and
-- fleet-maintenance.js) would raise here instead of doing nothing.
CREATE OR REPLACE FUNCTION reject_case_variant_username() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('users.username:' || LOWER(NEW.username)));
  IF EXISTS (
    SELECT 1 FROM users u
     WHERE LOWER(u.username) = LOWER(NEW.username)
       AND u.username <> NEW.username
       AND u.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'username % is taken', NEW.username
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_reject_case_variant_username'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_reject_case_variant_username
      BEFORE INSERT OR UPDATE OF username ON users
      FOR EACH ROW EXECUTE FUNCTION reject_case_variant_username();
  END IF;
END $$;

-- ── Waitlist email verification codes ──────────────────────────────────
--
-- The six-digit code that rides beside the one-click confirm link in the
-- join mail (the onboarding doc's "Email + verification code"). Both work
-- and both stamp waitlist_signups.confirmed_at; whichever the signer uses
-- first wins. The code exists for the phone, where leaving the app for the
-- mail client loses the WebView's place.
--
-- Same shape and same guarantees as `mobile_otp_codes`, deliberately: only
-- the bcrypt hash is stored, one live code per address, capped attempts and
-- a short expiry. Keyed by email like the waitlist itself, so a code can
-- exist before any account does. Schema only is migrated; rows are not.
CREATE TABLE IF NOT EXISTS waitlist_verification_codes (
  id           BIGSERIAL PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_verification_codes_email
  ON waitlist_verification_codes (email);
COMMENT ON TABLE waitlist_verification_codes IS 'staging:private';

-- ── Waitlist invite links ──────────────────────────────────────────────
--
-- `invite_code` is the shareable half of a signup's link
-- (/#waitlist?ref=<code>), minted on demand the first time the stage-2
-- form asks for it and stable thereafter — by the second ask it may
-- already be in somebody's group chat.
--
-- `invited_by` is who that link brought in. It is set at INSERT time and
-- therefore only on a FIRST join, so re-submitting with a different code
-- can never re-parent an existing row: ON CONFLICT DO NOTHING enforces
-- that for free rather than a separate guard having to.
--
-- This replaces the five typed email addresses the stage-2 form used to
-- collect, which sent nothing and attributed nothing.
--
-- The graph is recorded and displayed; NOTHING consumes it to form a
-- cohort. Admitting people together is a later, separate decision.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_invite_code
  ON waitlist_signups (invite_code) WHERE invite_code IS NOT NULL;
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS invited_by BIGINT
  REFERENCES waitlist_signups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_invited_by
  ON waitlist_signups (invited_by);
COMMENT ON COLUMN waitlist_signups.invite_code IS 'staging:private';

-- `project_invite_id` is the project invite that brought a signup in: the
-- pending `app_email_invites` row for the address when it first joined,
-- earliest first (that mail is the one certain to have gone out; later ones
-- can be throttled). Joining it back gives the project (`app_id`) and who
-- typed the address (`invited_by`). Like `invited_by` above, it is set only
-- by the INSERT, so a re-join never re-attributes a row.
--
-- Deliberately NOT a foreign key. `app_email_invites` is staging:private,
-- and the staging clone TRUNCATEs every table holding a key into a private
-- one (db-manager's TRUNCATE … CASCADE closure), which would empty the whole
-- waitlist in every preview. Invite ids are never reused, so an id whose
-- invite was deleted (its project, or its inviter's account, went) joins
-- to nothing rather than to someone else's.
ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS project_invite_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_project_invite
  ON waitlist_signups (project_invite_id) WHERE project_invite_id IS NOT NULL;
COMMENT ON COLUMN waitlist_signups.project_invite_id IS 'staging:private';

-- ── Phone rows on the waitlist (#4223) ─────────────────────────────────
--
-- An account with a verified phone (user_phone_identities) joins from
-- Home's waitlist card with one tap and no email (services/member-waitlist.js,
-- joinWithPhone). Its row has email NULL, linked_user_id set and
-- confirmed_at stamped at insert: the verified phone stands for the
-- confirmation. Releasing one is HELD until outbound SMS exists (#4096), so
-- releaseWaitlistSignup refuses a row without an address.
--
-- The UNIQUE constraint on email stays: emails are stored lowercased by every
-- writer, `ON CONFLICT (email)` names it, and NULLs are distinct under it, so
-- any number of phone rows fit. The case-insensitive index below states the
-- same rule on LOWER(email), created the way users_email_lower_unique is: a
-- legacy case-variant pair downgrades to a warning, never a boot failure.
--
-- One phone row per account. Not one row of ANY kind per account: rows
-- linked twice already exist (an account that confirmed two addresses on the
-- card) and a full index would fail to build on them, and an account merge
-- (services/user-merge.js) drops a merged account's rows that collide on a
-- unique index, which would delete a real email signup. The member card's
-- own writers keep the wider rule: joinWithPhone inserts only for an account
-- with no listed row, and adding an email folds the phone row into it.
ALTER TABLE waitlist_signups ALTER COLUMN email DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema() AND indexname = 'waitlist_signups_email_lower_unique'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX waitlist_signups_email_lower_unique
        ON waitlist_signups (LOWER(email)) WHERE email IS NOT NULL;
    EXCEPTION WHEN unique_violation THEN
      RAISE WARNING 'waitlist_signups_email_lower_unique not created: case-variant duplicate emails exist; the raw-column UNIQUE (email) is kept';
    END;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_phone_row_unique
  ON waitlist_signups (linked_user_id) WHERE email IS NULL;

-- ── Proposal freshness (#1442) ─────────────────────────────────────────
--
-- Three numbers a voter reads off a promoted proposal — how far behind main
-- it is, whether it merges cleanly, and what its checks ran against — were
-- all frozen at submission time. Nothing re-derived them once a proposal was
-- promoted and waiting for votes: every existing writer of behind_main and
-- merge_conflict_state needs a worker turn, an imported-PR head change, or a
-- merge attempt the gate only makes once a proposal is already mergeable. So
-- a proposal eight commits behind main, conflicting in seven files, with 412
-- checks passing against a base that had since been superseded, presented as
-- ready to merge.
--
-- These columns are a WRITE-THROUGH CACHE of GitHub's own answers, filled by
-- services/proposal-freshness.js from a leader-only sweeper pass and a
-- TTL-gated refresh on single-proposal reads. Every one is nullable and
-- advisory: NULL means "not measured yet", which reads as "unknown" rather
-- than as a claim, and no merge gate consults any of them.
--
-- The one exception is behind_main, which keeps its existing column and its
-- existing role in the merge gate. The freshness pass writes THROUGH to it
-- from freshness_behind_by, so the gate keeps reading one number and that
-- number stops being stale.
--
-- Why NOT reuse merge_conflict_state / conflict_files for the predicted
-- conflict: those two mean "a merge was actually attempted and this is what
-- happened", which is what the merge queue and the
-- merge gate both key off. A PREDICTION is a different claim, so it gets its
-- own columns and the queue never reads it.
--
--   checks_base_sha            main's head at the moment this proposal's
--                              checks snapshot was opened. The missing
--                              column: without it, checks staleness could
--                              only ever be branch-scoped ("did the branch
--                              move?"), never base-scoped ("is what it was
--                              tested against still what it would merge
--                              into?").
--   freshness_main_sha         main's head at the last refresh.
--   freshness_merge_base_sha   merge base of main and the proposal head.
--   freshness_behind_by        commits on main the proposal does not have.
--   freshness_ahead_by         commits the proposal has that main does not.
--   mergeability               'clean' | 'conflict' | 'unknown', from the
--                              pull request's own `mergeable` field. GitHub
--                              answers null while it computes, which is why
--                              'unknown' is a first-class value and never
--                              overwrites a known 'conflict'.
--   mergeability_files         predicted conflicting paths: the intersection
--                              of both sides' changed files. GitHub exposes
--                              no conflicting-file list, so this is an upper
--                              bound on where a human would have to look.
--   mergeability_files_complete  false when either compare hit GitHub's
--                              300-file cap, so the list is a sample.
--   checks_base_verdict        'current' | 'superseded' | 'unknown' —
--                              whether checks_base_sha is still an ancestor
--                              of main's head.
--   checks_base_behind_by      how many commits main has moved since.
--   freshness_checked_at       when the last refresh ran, successful or not.
--   freshness_error            why the last refresh could not answer. A
--                              refresh NEVER throws; it records this and
--                              leaves the previous numbers in place.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_base_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_main_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_merge_base_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_behind_by INTEGER;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_ahead_by INTEGER;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS mergeability TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS mergeability_files JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS mergeability_files_complete BOOLEAN;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_base_verdict TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_base_behind_by INTEGER;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_checked_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS freshness_error TEXT;
-- The sweeper's candidate ordering: promoted rows, least-recently-checked
-- first, NULLs (never checked) ahead of everything.
CREATE INDEX IF NOT EXISTS chat_sessions_freshness_checked_idx
  ON chat_sessions (freshness_checked_at NULLS FIRST)
  WHERE status = 'promoted';

-- #2038 — the integration record, and the approval epoch.
--
-- ── One fact, one writer ───────────────────────────────────────────────
--
-- The block above is the third set of columns describing "where does this
-- proposal stand relative to main". behind_main was the first, the
-- merge_conflict_state / conflict_files pair the second. Five writers touch
-- those six groups on unrelated triggers and none of them owns the answer,
-- so they disagree with each other in normal operation: the proposal card
-- reads freshness_behind_by while the merge gate reads behind_main, and a
-- successful sync writes only the second. merge_conflict_state has no
-- re-measuring writer at all — once a merge attempt stamps 'conflict' there,
-- nothing ever clears it except another resolve, which may never run.
--
-- These columns replace all six groups with ONE answer, written by ONE
-- writer (services/integration.js), carrying ONE timestamp. Everything else
-- reads it; nothing else writes it.
--
-- The answers come from a local bare mirror (services/repo-mirror.js), not
-- from GitHub's REST API, so they are exact rather than estimated and cost
-- no rate limit: behind_by is a rev-list count, merges_clean and
-- conflict_paths come from a real `git merge-tree`, and checks_base_current
-- is a merge-base ancestry test.
--
-- integration_measured_at is deliberately a FIRST-CLASS field rather than
-- an implementation detail. The card renders it ("behind by 6, measured 30
-- seconds ago") instead of stating a number with implied freshness it does
-- not have. A cache that admits its age is not the same object as a cache
-- that pretends to be live, and the second one is what every "the UI is out
-- of sync" report was actually about.
--
--   integration_head_sha        the proposal head this answer describes. An
--                               answer about a head that has since moved is
--                               stale by construction, and this is how a
--                               reader tells.
--   integration_main_sha        the default branch's head at measure time.
--   integration_base_sha        merge base of the two.
--   integration_behind_by       exact count of commits main has that the
--                               proposal does not.
--   integration_ahead_by        the reverse.
--   integration_merges_clean    from an actual merge, not a prediction.
--                               NULL only when the measurement failed.
--   integration_conflict_paths  the genuinely conflicted paths. Not the
--                               upper bound mergeability_files had to be:
--                               git reports exactly the files it could not
--                               resolve.
--   integration_merged_tree     the tree a merge WOULD produce. This is the
--                               value that lets approval follow the patch:
--                               when the head moves, the new tree either
--                               equals this (nobody wrote anything — a
--                               mechanical merge) or it does not.
--   integration_checks_base_current  is the commit this proposal's checks
--                               ran against still on main's history.
--   integration_block_reasons   what the SERVER knows is holding this
--                               proposal that the browser cannot derive from
--                               columns: 'integrating' (the queue is working
--                               on it right now) and 'budget' (it needs a
--                               merge with main but the shared token budget
--                               is spent). A LIST, not one value, because
--                               #2026 established that a card says every
--                               reason that applies — ranking them into one
--                               slot is how "Behind main" hid "Checks
--                               failing". The browser keeps deriving the
--                               rest from the columns it already reads;
--                               these two are appended to that list.
--   integration_error           why the last measurement could not answer.
--                               A measurement never throws: it records this
--                               and leaves the previous numbers in place.
--
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_measured_at TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_head_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_main_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_base_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_behind_by INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_ahead_by INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_merges_clean BOOLEAN;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_conflict_paths JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_merged_tree VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_checks_base_current BOOLEAN;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_block_reasons JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_error TEXT;

-- ── The approval epoch ─────────────────────────────────────────────────
--
-- What a vote is pinned to, replacing the commit pin.
--
-- reviewed_head_sha pins an approval to a COMMIT, and a sync commit changes
-- the commit without changing the code under review. Telling those apart
-- needed a provenance ledger (session_platform_pushes), a five-hop
-- first-parent walk and a three-way classifier, because a commit's SHAPE can
-- be forged: anyone can craft a merge whose first parent is the reviewed SHA.
--
-- An epoch cannot be forged because it is not derived from the branch at all.
-- It is a counter the PLATFORM bumps, and it bumps on exactly one event:
-- somebody wrote bytes that were not already approved. A mechanical merge of
-- main — proven mechanical by recomputing it, see integration_merged_tree —
-- does not bump it, so the approvals simply keep counting and there is
-- nothing to carry, advance or reconcile.
--
-- It is also what the browser sends back with a vote. The old guard compared
-- the rendered commit to the live head and rejected any difference, which
-- cost a voter their click on every platform sync — including the ones that
-- had just certified the code had not changed. An epoch compares the right
-- thing: "is this still the proposal you were shown?"
--
--   chat_sessions.approval_epoch  bumped when approvals are cleared.
--   pr_votes.approval_epoch       the epoch the vote was cast under. A vote
--                                 counts while the two are equal.
--
-- Backfill: existing rows start at epoch 0, and a vote inherits epoch 0 when
-- it counted under the OLD rule. That rule is reproduced here exactly, and
-- the reproduction is the point — #2050. The old predicate was
--
--     (<reviewed head> IS NULL OR LOWER(pv.head_sha) = LOWER(<reviewed head>))
--
-- and this backfill originally kept only its second half. The half it dropped
-- is not an edge case: a session with no reviewed head counted EVERY vote on
-- it, which is every rename PR (services/rename-pr.js opens one with no head
-- and carries people's issue votes onto it) and every staging fixture. All of
-- them silently fell to a zero tally the moment the migration ran. The
-- original claim that it "changes no tally in either direction" was wrong
-- about exactly this, so the condition now says what the claim always meant.
--
-- A vote genuinely stale under the old rule still keeps a NULL epoch, and
-- NULL never equals 0, so it stays uncounted with nothing having to delete
-- it. A vote made stale LATER is untouched here: clearApprovals bumps the
-- session's epoch and leaves the vote's alone, so it is not NULL and this
-- does not see it. Epoch 0 rather than the session's current epoch for the
-- same reason — a session that has since cleared its approvals must not have
-- votes reappear underneath it, and 0 is inert there.
--
-- It re-runs on every boot (the schema is applied at db/migrate.js:30) and is
-- idempotent, which is what lets it also rescue the rows written dead after
-- the first run, before the trigger below existed.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS approval_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pr_votes      ADD COLUMN IF NOT EXISTS approval_epoch INTEGER;

UPDATE pr_votes pv
   SET approval_epoch = 0
  FROM chat_sessions cs
 WHERE cs.id = pv.session_id
   AND pv.approval_epoch IS NULL
   AND ((CASE WHEN cs.source = 'imported'
              THEN cs.imported_pr_head_sha ELSE cs.reviewed_head_sha END) IS NULL
        OR LOWER(pv.head_sha) = LOWER(
             CASE WHEN cs.source = 'imported'
                  THEN cs.imported_pr_head_sha ELSE cs.reviewed_head_sha END));

-- ── Every vote is born at an epoch ─────────────────────────────────────
--
-- The predicate above is an equality against a NULLABLE column, and NULL
-- equals nothing. That is deliberate for the backfill — it is what carries a
-- stale vote across uncounted without anything having to delete it — and it
-- is exactly wrong for an INSERT: a statement that omits the column writes a
-- vote that can NEVER count, however the group votes.
--
-- Only routes/votes.js's two recordVote statements named it. The other
-- thirteen INSERT INTO pr_votes sites did not, and wrote dead rows (#2050):
-- services/rename-pr.js carrying real people's issue votes onto a rename PR,
-- and twelve staging seeds whose entire purpose is a non-zero tally. The
-- schema is applied before any of them (db/migrate.js applies it at the top
-- of boot and the seeds run after), so the backfill cannot rescue a row that
-- does not exist yet.
--
-- Stamping it here rather than at fifteen call sites makes the invariant
-- structural. services/pr-vote-revision.js is the one definition of which
-- approvals count; this is that definition's write-side half, and it holds
-- for a caller that has never heard of epochs — which twelve of them, sitting
-- in seed code, reasonably have not.
--
-- The WHEN clause tests the VALUE, not whether the statement named the
-- column, so an explicit NULL is stamped too: after this, NO insert can
-- produce a vote that cannot count. An epoch the caller actually supplies is
-- never touched — recordVote still decides what a real vote is cast under,
-- and those inserts do not reach the function at all.
--
-- It does not resurrect the backfill's stale votes: those are an UPDATE and
-- this fires on INSERT. Nor does it disturb a staging clone, which is
-- pg_dump -Fc | pg_restore: triggers are restored in the post-data section,
-- after the COPY, so a stale NULL arrives in staging still NULL.
CREATE OR REPLACE FUNCTION stamp_pr_vote_approval_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A vote whose session does not exist leaves this NULL and stays
  -- uncounted, which is the right answer; the foreign key refuses it anyway.
  SELECT cs.approval_epoch INTO NEW.approval_epoch
    FROM chat_sessions cs
   WHERE cs.id = NEW.session_id;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'pr_votes_stamp_approval_epoch'
       AND tgrelid = 'pr_votes'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER pr_votes_stamp_approval_epoch
      BEFORE INSERT ON pr_votes
      FOR EACH ROW WHEN (NEW.approval_epoch IS NULL)
      EXECUTE FUNCTION stamp_pr_vote_approval_epoch();
  END IF;
END $$;

-- ── What a proposal still needs before it merges ───────────────────────
--
-- A recording of what the merge gate actually did on its last run: an ordered
-- list of the gates it cleared and the one that refused, written from the same
-- call sites that already narrate into merge_debug_runs.
--
-- It is a DESCRIPTION, never an input. Nothing reads it to decide whether a
-- proposal may merge — the merge gate re-evaluates everything from scratch
-- every time — so a stale or missing record costs a card its checklist and
-- costs the merge nothing. services/merge-gate.js turns it, plus that file's
-- static gate order, into the list the card renders.
--
-- Why a recording rather than a second evaluator: re-deriving the gate's
-- conditions anywhere else means two implementations of "can this merge",
-- drifting, with the describing one eventually lying about the deciding one.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merge_requirements JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merge_requirements_at TIMESTAMPTZ;

-- The measurement sweep's candidate ordering: promoted rows, least recently
-- measured first, never-measured ahead of everything. Mirrors the freshness
-- index above, which it replaces once that pass is retired.
CREATE INDEX IF NOT EXISTS chat_sessions_integration_measured_idx
  ON chat_sessions (integration_measured_at NULLS FIRST)
  WHERE status = 'promoted';

-- ── Direct-merge lanes ─────────────────────────────────────────────────
--
-- A proposal that merges cleanly with main merges as it stands: being
-- behind is no longer a reason to bring it up to date first, and the
-- platform's own sync no longer precedes a merge (the merge-queue machine, src/workflow/merge-queue/).
-- Only a measured CONFLICT costs a worker turn, and the conflict lane
-- admits one pre-approval resolution per authored head — the author's work
-- gets one chance to be made mergeable before anyone has voted on it, and
-- unlimited chances once the group has approved it. What ties a resolution
-- to "this authored head" is the approval epoch: an authored push bumps
-- it, a mechanical or resolved move does not (see The approval epoch,
-- above), so "spent in this epoch" is exactly "spent on this author's
-- work".
--
--   integration_resolved_epoch  the approval_epoch during which the queue
--                               last spent a pre-approval resolution on
--                               this proposal. NULL: never. Equal to the
--                               current approval_epoch: the one resolution
--                               this authored head gets before approval is
--                               used, and a further conflict waits for the
--                               vote. Different: the author has pushed
--                               since, and the new head has its own.
--
-- check_phase gains 'deferred' beside 'building' / 'testing': a promoted
-- head that conflicts with main gets its preview and screenshots (so the
-- group can review it) but no assertions and no unit suite, because a
-- tree that cannot merge is not the tree that would be tested after the
-- resolution. The verdict stays 'pending' with this phase until the head
-- merges cleanly, at which point the checks run (services/check-admission.js).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS integration_resolved_epoch INTEGER;

-- The one exception to "behind is not a reason to sync": a promoted
-- proposal whose preview fails to START while it is behind main and merges
-- cleanly is synced by the platform (services/boot-failure-sync.js).
-- Previews boot against production's database, which runs main's schema, so
-- a schema change on main can stop an older branch's preview at once (#4186
-- against #4172).
--
--   boot_failure_sync_head  the head the platform last synced for that
--                           reason. NULL: never. Equal to the failed head: it
--                           was tried, and a further failure on the same head
--                           waits for a person. The sync's own head contains
--                           main, so nothing syncs again until main moves.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS boot_failure_sync_head TEXT;

-- A proposal's own passes of checks no merge has made blocking yet
-- (services/check-history.js). They block its later heads at once, and
-- everybody's once it merges.
--
--   checks_earned_keys        the check keys it has passed that were not
--                             yet blocking for everybody. NULL: none.
--   checks_earned_settled_at  when, after it merged, those were folded into
--                             app_check_history.merged_pass_at. NULL: not
--                             yet (or it has not merged).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS checks_earned_keys TEXT[];
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS checks_earned_settled_at TIMESTAMPTZ;
-- Only the rows still to fold in, so the read every checks run makes is an
-- index probe on a handful of rows.
CREATE INDEX IF NOT EXISTS chat_sessions_checks_earned_unsettled_idx
  ON chat_sessions(app_id) WHERE checks_earned_keys IS NOT NULL AND checks_earned_settled_at IS NULL;

-- The second exception to "behind is not a reason to sync": a promoted
-- proposal whose only blocking failures are checks main now passes, and
-- that fail on other open proposals too, is synced by the platform
-- (services/fixed-check-sync.js). It was main that failed them, so the
-- proposal's verdict is about code it never had.
--
--   fixed_check_sync_head  the head the platform last synced for that
--                          reason. A head is synced at most once.
--   fixed_check_sync_keys  every check it was synced for. A check that
--                          still fails once the proposal contains a main
--                          that passes it is the proposal's own, and is
--                          never a reason to sync it again. The unit suite,
--                          one row for every test, is the exception: each
--                          sync for it is recorded as <key>@<main's tip>,
--                          and a main that moved on and is green may sync
--                          it again, up to three times in all.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_head TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_keys TEXT[];

-- ── Main watch ─────────────────────────────────────────────────────────
--
-- The safety net under direct merges. Each merge lands a tree nobody ran
-- the checks against as a whole (the proposal was checked on its own head,
-- against the main of the time), so after every merge the repo's unit
-- suite runs once more on the merge commit (services/main-watch.js). Red
-- pauses the app's merges until a fix lands or an admin resumes them;
-- nothing is rolled back, and the culprit is whatever landed since the
-- last green.
--
--   main_check_state        'running' | 'confirming' | 'passing' |
--                           'failing' | 'error' | 'skipped'. NULL: never
--                           run. 'confirming' is a first red being re-run
--                           once on the same commit before it counts —
--                           flaky tests exist, and one paused the
--                           platform's merges for an afternoon. 'error' is
--                           a run that could not happen (no runner, no
--                           clone) and says nothing about main; 'skipped'
--                           is a repo with no runnable test script.
--   main_check_sha          the merge commit the state describes.
--   main_check_at           when that run finished (or started, while
--                           'running' / 'confirming').
--   main_check_detail       the run's own account: failing tests, the
--                           TAP summary, the PR that landed it; for a
--                           confirmed red, the first run too; for a flake,
--                           the failure that did not repeat.
--   main_check_paused_sha   the red commit the app's merge pause is about;
--                           NULL when merges are not paused. Set by a red
--                           verdict (provisional or confirmed), cleared by
--                           exactly two things: a green verdict, or an
--                           admin's resume. An 'error' run in between
--                           leaves it alone — a run that says nothing
--                           about main cannot lift a pause. Before this
--                           column the pause was DERIVED (state 'failing'
--                           at a sha not yet resumed), so a merge whose
--                           run merely could not happen silently lifted
--                           it; the backfill below carries the derived
--                           pauses over.
--   main_check_resumed_sha  the sha an admin's "resume merges" was about,
--                           so a red verdict still in flight for that same
--                           sha cannot re-pause. A later red is a new pause.
--
-- A red whose failing tests are all known flakes (main_test_flakes below)
-- is stored as 'failing' with detail.flakesOnly and does not pause: every
-- other test passed. The backfill leaves those rows alone.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_state VARCHAR(16);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_sha VARCHAR(40);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_detail JSONB;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_resumed_sha VARCHAR(40);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_check_paused_sha VARCHAR(40);
-- (Their derived pauses are carried over below the main-check guard.)

-- Every verdict main watch reached on a merge commit (services/main-red-fix.js),
-- kept even when a newer merge took the app's row before it could be stored
-- there: a superseded green is still the newest merge known to pass, and is
-- where a red's suspects are read from. `confirmed` is null for a green.
CREATE TABLE IF NOT EXISTS main_watch_verdicts (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  sha         VARCHAR(40) NOT NULL,
  state       VARCHAR(16) NOT NULL,
  superseded  BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed   BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_main_watch_verdicts_app ON main_watch_verdicts(app_id, state, created_at DESC);
-- A red that the same merge commit, run again, did not keep: it passed on
-- the confirm run or a recheck (state 'passing'), or failed twice on tests
-- that each passed the other time (disjointReds). The proposal-pipeline
-- topic's "Reds that passed on a re-run" counts them (topic-figures.js).
ALTER TABLE main_watch_verdicts ADD COLUMN IF NOT EXISTS flake BOOLEAN NOT NULL DEFAULT FALSE;

-- The requests main watch filed to fix a red main (services/main-red-fix.js),
-- one per red commit and one open per app at a time. `issue_number` is null
-- while one is being filed.
CREATE TABLE IF NOT EXISTS main_red_requests (
  id            BIGSERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  red_sha       VARCHAR(40) NOT NULL,
  issue_number  INTEGER,
  filed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, red_sha)
);

-- Tests main-watch saw fail and then pass on the same merge commit
-- (services/main-watch.js). A red whose failures are all tests seen here in
-- the last 30 days pauses no merges, and each test gets one request to fix
-- it (filed as Homeroom bot) at most every 14 days, none while the last is
-- open. `file` is '' when the suite's output named no file for the test.
CREATE TABLE IF NOT EXISTS main_test_flakes (
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  file                 TEXT NOT NULL DEFAULT '',
  test                 TEXT NOT NULL,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count           INTEGER NOT NULL DEFAULT 1,
  last_sha             VARCHAR(40),
  request_issue_number INTEGER,
  request_filed_at     TIMESTAMPTZ,
  PRIMARY KEY (app_id, file, test)
);
-- The work item that took a claim (main_red_requests.claimed_by, and
-- request_claimed_by here: the main-check machine's wf_work id), written by
-- the claim's own statement, so the attempt after a crash knows the claim is
-- its own and carries the filing on, whenever the crash came. Null for a
-- claim an older release took.
ALTER TABLE main_red_requests ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE main_test_flakes ADD COLUMN IF NOT EXISTS request_claimed_by TEXT;

-- #2253: a ceiling on each app's own Postgres database. Uploaded files have
-- had a per-app cap since app-files.js; the database had none, and one app
-- writing rows in a loop could fill the volume every app shares. The leader
-- measures every app database on a timer (services/app-storage-cap.js) and
-- records the result here; at the cap the app's owner role is switched to
-- default_transaction_read_only and its admins are notified, and it thaws
-- once the database shrinks under 95% of the cap, an admin raises the cap,
-- or a grace window is open.
--
--   db_size_bytes           pg_database_size() at the last measurement.
--   db_size_measured_at     when that measurement was taken.
--   db_storage_cap_bytes    an admin's per-app override; NULL means the
--                           platform default (APP_DB_STORAGE_CAP_BYTES).
--   db_storage_frozen_at    set while the database is read-only for size.
--   db_storage_warned_at    set once the warning line was crossed and the
--                           admins told; cleared when the database drops
--                           back under it, so the next crossing warns again.
--   db_storage_grace_until  an admin's "allow writes" window: the database
--                           stays writable until then whatever its size.
--
-- None of these is a secret: they are the app's own operational state, and
-- the admin console's App storage section is the surface that shows them.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_size_bytes BIGINT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_size_measured_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_storage_cap_bytes BIGINT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_storage_frozen_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_storage_warned_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_storage_grace_until TIMESTAMPTZ;

-- The Needs-you deck's ask box (services/workshop-ask.js): one person's
-- own questions about one card, and the answers they got.
--
-- PRIVATE, and not a close call. A voter's questions about a change they
-- have not voted on yet say what they are unsure about and which way they
-- are leaning, on a platform where the vote itself is the product. That is
-- personal information beyond a public username, so the table is
-- `staging:private` and a staging clone arrives with the schema and none
-- of the rows.
--
-- It is a thread PER USER per card, never a shared one. Nothing reads
-- these rows but the person who wrote them: every query carries both
-- app_id and user_id, and there is no route that lists another member's.
--
-- `target_kind` / `target_ref` are the deck's own address for a card
-- ('proposal' + chat_sessions.id, 'gov' + issues.id, 'issue' + a GitHub
-- number). Deliberately NOT a foreign key: the three kinds live in three
-- places and one of them is not a table at all. The cost is that a
-- deleted session leaves its rows behind; they are small, invisible to
-- everyone but their author, and dropped with the app.
CREATE TABLE IF NOT EXISTS workshop_ask_messages (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_kind VARCHAR(16) NOT NULL,
  target_ref  INTEGER NOT NULL,
  -- 'you' or 'ai', matching the pane's own vocabulary rather than the
  -- Anthropic role names: what is stored is a transcript of a UI, and the
  -- mapping to user/assistant belongs at the call site.
  role        VARCHAR(16) NOT NULL,
  body        TEXT NOT NULL,
  model       VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE workshop_ask_messages IS 'staging:private';
-- The only access path there is: one thread, in order. id rather than
-- created_at as the tiebreak, because two turns of one exchange land in
-- the same transaction and can share a timestamp.
CREATE INDEX IF NOT EXISTS idx_workshop_ask_thread
  ON workshop_ask_messages (app_id, user_id, target_kind, target_ref, id);

-- Durable manifest of a checks run whose containers are in flight
-- (services/check-runs.js). Written just before the capture / unit-suite
-- Jobs are created, heartbeated by the owning process while they run, and
-- deleted once the verdict is stored. Its only reader is the harvester
-- (services/check-harvest.js), which adopts a row whose owner has stopped
-- heartbeating — a platform rollout replaced the Pod — and settles the run
-- from the Job's own output instead of starting the suite over. The
-- manifest holds everything the verdict needs that is not in the log:
-- the dispatch table, the capture targets, the staging origin, the trigger.
CREATE TABLE IF NOT EXISTS check_runs (
  run_id       UUID PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  commit_sha   VARCHAR(40),
  owner        TEXT NOT NULL,
  manifest     JSONB NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE check_runs IS 'staging:private';
CREATE INDEX IF NOT EXISTS idx_check_runs_session ON check_runs (session_id);
-- The checks queue (services/checks-queue.js). A row now exists for the
-- whole life of a run, from the moment it asks for a checks slot to the
-- moment it settles: admitted_at is NULL while it waits and stamped once it
-- holds one of the CHECKS_MAX_CONCURRENT_RUNS slots. The live rows ARE the
-- slot count, so there is no second ledger to keep in step with them.
--   kind        'proposal' (a session's capture and unit-suite Jobs) or
--               'main' (main-watch's unit suite on a merge commit, which has
--               no session: session_id is NULL and app_id names the app).
--   queued_at   its place in line, FIFO within its class. A run that a
--               restart re-drives keeps the place it had.
--   admitted_at NULL while waiting. The default is NOW() so a row written
--               by code that does not queue (a release from before this
--               one, mid-rollout) counts as the running run it is.
-- Guarded so a boot that finds the column already nullable takes no lock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'check_runs'::regclass AND attname = 'session_id' AND attnotnull
  ) THEN
    ALTER TABLE check_runs ALTER COLUMN session_id DROP NOT NULL;
  END IF;
END $$;
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'proposal';
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS app_id INTEGER REFERENCES apps(id) ON DELETE CASCADE;
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_check_runs_app ON check_runs (app_id) WHERE app_id IS NOT NULL;

-- Renamed from visual_evidence_* when visual evidence became before & after
-- shots. Guarded so boot is idempotent either way: an existing deployment
-- renames in place and keeps its rows, a fresh one falls straight through
-- to the CREATEs below.
--
-- The previous release's pods keep serving through the rolling update after
-- this runs, and they still name the old tables and columns. So a renamed
-- deployment also keeps the old names answering for them: a view under each
-- old table name, and a legacy copy of each chat_sessions column that
-- chat_sessions_shots_legacy_sync() keeps equal to the new one, in both
-- directions. Nothing in this release reads either. Once no deployment runs
-- an older release, drop the three views, the trigger and its function, and
-- the four chat_sessions.visual_evidence_* columns. A rollback past this
-- release needs the views dropped and the renames reversed by hand first.
DO $$
DECLARE
  pair TEXT[];
  rec RECORD;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ['visual_evidence_runs', 'shot_runs'],
    ['visual_evidence_artifacts', 'shot_artifacts'],
    ['visual_evidence_diagnostic_artifacts', 'shot_diagnostic_artifacts']
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = pair[1]
                  AND table_type = 'BASE TABLE')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = pair[2])
    THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', pair[1], pair[2]);
      EXECUTE format('CREATE VIEW %I AS SELECT * FROM %I', pair[1], pair[2]);
    END IF;
  END LOOP;
  -- Constraint and index names carry the old table names too.
  FOR rec IN
    SELECT con.conname, con.conrelid::regclass::text AS rel
      FROM pg_constraint con
     WHERE con.conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace
                              AND relname IN ('shot_runs', 'shot_artifacts', 'shot_diagnostic_artifacts'))
       AND con.conname LIKE 'visual\_evidence\_%'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = replace(rec.conname, 'visual_evidence_', 'shot_')
                      AND connamespace = current_schema()::regnamespace) THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
        rec.rel, rec.conname, replace(rec.conname, 'visual_evidence_', 'shot_'));
    END IF;
  END LOOP;
  FOR rec IN
    SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename IN ('shot_runs', 'shot_artifacts', 'shot_diagnostic_artifacts')
       AND indexname LIKE 'idx\_visual\_evidence\_%'
  LOOP
    IF to_regclass(replace(rec.indexname, 'idx_visual_evidence_', 'idx_shot_')) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I',
        rec.indexname, replace(rec.indexname, 'idx_visual_evidence_', 'idx_shot_'));
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'chat_sessions'
                AND column_name = 'visual_evidence_state')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'chat_sessions'
                AND column_name = 'shots_state')
  THEN
    ALTER TABLE chat_sessions RENAME COLUMN visual_evidence_state TO shots_state;
    ALTER TABLE chat_sessions RENAME COLUMN visual_evidence_run_id TO shots_run_id;
    ALTER TABLE chat_sessions RENAME COLUMN visual_evidence_detail TO shots_detail;
    ALTER TABLE chat_sessions RENAME COLUMN visual_evidence_updated_at TO shots_updated_at;
    ALTER TABLE chat_sessions
      ADD COLUMN visual_evidence_state VARCHAR(24),
      ADD COLUMN visual_evidence_run_id VARCHAR(32),
      ADD COLUMN visual_evidence_detail JSONB,
      ADD COLUMN visual_evidence_updated_at TIMESTAMPTZ;
    UPDATE chat_sessions
       SET visual_evidence_state = shots_state, visual_evidence_run_id = shots_run_id,
           visual_evidence_detail = shots_detail, visual_evidence_updated_at = shots_updated_at
     WHERE shots_state IS NOT NULL OR shots_run_id IS NOT NULL
        OR shots_detail IS NOT NULL OR shots_updated_at IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'chat_sessions'
                AND column_name = 'visual_evidence_state')
  THEN
    CREATE OR REPLACE FUNCTION chat_sessions_shots_legacy_sync() RETURNS trigger AS $fn$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.shots_state := COALESCE(NEW.shots_state, NEW.visual_evidence_state);
        NEW.shots_run_id := COALESCE(NEW.shots_run_id, NEW.visual_evidence_run_id);
        NEW.shots_detail := COALESCE(NEW.shots_detail, NEW.visual_evidence_detail);
        NEW.shots_updated_at := COALESCE(NEW.shots_updated_at, NEW.visual_evidence_updated_at);
      ELSE
        IF NEW.shots_state IS NOT DISTINCT FROM OLD.shots_state THEN
          NEW.shots_state := NEW.visual_evidence_state;
        END IF;
        IF NEW.shots_run_id IS NOT DISTINCT FROM OLD.shots_run_id THEN
          NEW.shots_run_id := NEW.visual_evidence_run_id;
        END IF;
        IF NEW.shots_detail IS NOT DISTINCT FROM OLD.shots_detail THEN
          NEW.shots_detail := NEW.visual_evidence_detail;
        END IF;
        IF NEW.shots_updated_at IS NOT DISTINCT FROM OLD.shots_updated_at THEN
          NEW.shots_updated_at := NEW.visual_evidence_updated_at;
        END IF;
      END IF;
      NEW.visual_evidence_state := NEW.shots_state;
      NEW.visual_evidence_run_id := NEW.shots_run_id;
      NEW.visual_evidence_detail := NEW.shots_detail;
      NEW.visual_evidence_updated_at := NEW.shots_updated_at;
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_sessions_shots_legacy_sync'
                     AND tgrelid = 'chat_sessions'::regclass AND NOT tgisinternal) THEN
      CREATE TRIGGER chat_sessions_shots_legacy_sync
        BEFORE INSERT OR UPDATE ON chat_sessions
        FOR EACH ROW EXECUTE FUNCTION chat_sessions_shots_legacy_sync();
    END IF;
  END IF;
END $$;

-- #2380: agent-authored, revision-scoped before & after shots. The hot proposal
-- reads need only the current state and a bounded public summary; executable
-- plans, verdicts and binary artifacts live in their own private tables.
-- A head change clears these pointers synchronously through
-- services/shots-state.js so a screenshot from an older revision
-- can never be presented as shots of newer code.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shots_state VARCHAR(24);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shots_run_id VARCHAR(32);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shots_detail JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS shots_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS shot_runs (
  id                     VARCHAR(32) PRIMARY KEY
    CHECK (id ~ '^[0-9a-f]{32}$'),
  session_id             INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  base_sha               VARCHAR(40) NOT NULL
    CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha               VARCHAR(40) NOT NULL
    CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  plan_version           INTEGER NOT NULL DEFAULT 1 CHECK (plan_version = 1),
  plan_hash              VARCHAR(64)
    CHECK (plan_hash IS NULL OR plan_hash ~ '^[0-9a-f]{64}$'),
  intent                 JSONB NOT NULL,
  author_plan            JSONB,
  replay_plan            JSONB,
  trace_summary          JSONB,
  hard_verdict           JSONB,
  semantic_verdict       JSONB,
  state                  VARCHAR(24) NOT NULL,
  trigger                VARCHAR(32),
  failure_code           VARCHAR(48),
  failure_reason         TEXT,
  fixture_fingerprint    VARCHAR(128),
  base_image_digest      TEXT,
  head_image_digest      TEXT,
  repair_attempt         SMALLINT NOT NULL DEFAULT 0
    CHECK (repair_attempt BETWEEN 0 AND 1),
  override_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  override_reason        TEXT,
  overridden_at          TIMESTAMPTZ,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state IN (
    'planned', 'provisioning', 'exploring', 'replaying', 'reviewing',
    'verified', 'failed', 'stale', 'cancelled', 'not_required', 'overridden'
  )),
  CONSTRAINT shot_runs_verified_integrity_check
    CHECK (state <> 'verified' OR (plan_hash IS NOT NULL AND hard_verdict IS NOT NULL
      AND completed_at IS NOT NULL)),
  CHECK (state <> 'not_required' OR completed_at IS NOT NULL),
  CHECK (state <> 'overridden' OR (override_user_id IS NOT NULL
    AND NULLIF(BTRIM(override_reason), '') IS NOT NULL AND overridden_at IS NOT NULL
    AND completed_at IS NOT NULL))
);
ALTER TABLE shot_runs ADD COLUMN IF NOT EXISTS author_plan JSONB;
-- Earlier releases required a model's semantic verdict before captures could
-- be published. Capture integrity is still enforced; judging relevance now
-- belongs to the people reviewing the proposal.
DO $$
DECLARE old_constraint TEXT;
BEGIN
  FOR old_constraint IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'shot_runs'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%semantic_verdict%'
  LOOP
    EXECUTE format('ALTER TABLE shot_runs DROP CONSTRAINT %I', old_constraint);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_runs'::regclass
       AND conname = 'shot_runs_verified_integrity_check'
  ) THEN
    ALTER TABLE shot_runs
      ADD CONSTRAINT shot_runs_verified_integrity_check
      CHECK (state <> 'verified' OR (plan_hash IS NOT NULL AND hard_verdict IS NOT NULL
        AND completed_at IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_shot_runs_session_created
  ON shot_runs(session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_runs_current_head
  ON shot_runs(session_id, head_sha)
  WHERE state NOT IN ('stale', 'cancelled');
COMMENT ON TABLE shot_runs IS 'staging:private';

CREATE TABLE IF NOT EXISTS shot_artifacts (
  id                 VARCHAR(32) PRIMARY KEY
    CHECK (id ~ '^[0-9a-f]{32}$'),
  run_id             VARCHAR(32) NOT NULL REFERENCES shot_runs(id) ON DELETE CASCADE,
  story_id           VARCHAR(96) NOT NULL,
  viewport           VARCHAR(32) NOT NULL,
  side               VARCHAR(8) NOT NULL CHECK (side IN ('base', 'head', 'paired')),
  variant            VARCHAR(16) NOT NULL CHECK (variant IN ('focus', 'context', 'animation')),
  media              VARCHAR(8) NOT NULL CHECK (media IN ('png', 'webm', 'gif')),
  content_type       VARCHAR(32) NOT NULL,
  data               BYTEA NOT NULL,
  width              INTEGER CHECK (width IS NULL OR width > 0),
  height             INTEGER CHECK (height IS NULL OR height > 0),
  bytes              INTEGER NOT NULL CHECK (bytes >= 0),
  sha256              VARCHAR(64) NOT NULL
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  focus_rect         JSONB,
  stage_labels       JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, story_id, viewport, side, variant, media)
);
CREATE INDEX IF NOT EXISTS idx_shot_artifacts_run
  ON shot_artifacts(run_id, story_id, viewport);
COMMENT ON TABLE shot_artifacts IS 'staging:private';

-- A failed two-pass comparison must retain the four images needed to see
-- which pixels changed. These never enter reviewer-visible shots.
CREATE TABLE IF NOT EXISTS shot_diagnostic_artifacts (
  id             VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  run_id         VARCHAR(32) NOT NULL REFERENCES shot_runs(id) ON DELETE CASCADE,
  attempt        SMALLINT NOT NULL CHECK (attempt BETWEEN 1 AND 8),
  pass           SMALLINT NOT NULL CHECK (pass IN (1, 2)),
  story_id       VARCHAR(96) NOT NULL,
  viewport       VARCHAR(32) NOT NULL,
  side           VARCHAR(8) NOT NULL CHECK (side IN ('base', 'head')),
  variant        VARCHAR(16) NOT NULL CHECK (variant IN ('focus', 'context')),
  data           BYTEA NOT NULL,
  width          INTEGER NOT NULL CHECK (width > 0),
  height         INTEGER NOT NULL CHECK (height > 0),
  bytes          INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 8388608),
  sha256         VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, attempt, pass, story_id, viewport, side, variant)
);
CREATE INDEX IF NOT EXISTS idx_shot_diagnostic_artifacts_run
  ON shot_diagnostic_artifacts(run_id, attempt);
COMMENT ON TABLE shot_diagnostic_artifacts IS 'staging:private';

-- The shots agent's workspace for one run (a proposal's, or a shots eval's
-- trial): its brief, and what it has said so far through its tools (the
-- changes it skipped, its notes, the problems and conditions it noted).
-- Written by the agent's tool calls, through whichever web process serves
-- them (routes/internal.js, services/shots-control.js), so a restart of the
-- process that started the run loses nothing and the agent never has to
-- reach one particular Pod. The shots machine reads it once the agent's
-- turn has ended (src/workflow/shots/). `kind`: 'run' is checked against
-- the proposal's current run, 'trial' against nothing more (its runner owns
-- it). Removed with the run's copies.
CREATE TABLE IF NOT EXISTS shot_run_control (
  run_id             VARCHAR(32) PRIMARY KEY CHECK (run_id ~ '^[0-9a-f]{32}$'),
  kind               VARCHAR(8) NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'trial')),
  session_id         INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  intent             JSONB NOT NULL,
  context            JSONB NOT NULL,
  home_tiles         JSONB,
  after_only         BOOLEAN NOT NULL DEFAULT FALSE,
  -- What the agent's dispatch needs beyond the brief: the copies' internal
  -- addresses and the phone sign-in code their fixture copies accept.
  agent              JSONB,
  -- What the agent is doing now (its last tool, its provider calls), for
  -- the owner's diagnostics only: nothing decides on it.
  progress           JSONB,
  expires_at         TIMESTAMPTZ NOT NULL,
  skipped            JSONB NOT NULL DEFAULT '{}'::jsonb,
  failed             JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes              JSONB NOT NULL DEFAULT '{}'::jsonb,
  notices            JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions         JSONB NOT NULL DEFAULT '{}'::jsonb,
  skipped_all        TEXT,
  skipped_all_failed BOOLEAN NOT NULL DEFAULT FALSE,
  last_tool_failure  JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shot_run_control_session ON shot_run_control(session_id);
COMMENT ON TABLE shot_run_control IS 'staging:private';

-- Every shot and clip the agent saved for a run, one row per slot (saving
-- the same slot again replaces it). Published by copying the ready ones
-- into shot_artifacts in the transition that publishes the run.
CREATE TABLE IF NOT EXISTS shot_run_files (
  run_id        VARCHAR(32) NOT NULL REFERENCES shot_run_control(run_id) ON DELETE CASCADE,
  slot          VARCHAR(200) NOT NULL,
  story_id      VARCHAR(96) NOT NULL,
  viewport      VARCHAR(32) NOT NULL,
  side          VARCHAR(8) NOT NULL CHECK (side IN ('base', 'head')),
  variant       VARCHAR(16) NOT NULL CHECK (variant IN ('focus', 'context', 'animation')),
  media         VARCHAR(8) NOT NULL CHECK (media IN ('png', 'webm')),
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA NOT NULL,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  sha256        VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, slot)
);
-- #4459: a screen shot can be taken in both light and dark mode. Dark exists
-- only for whole-screen PNGs (context), so element shots and clips stay
-- light; the column's default makes every older row light, so older runs
-- need no backfill. Dark files live under their own slot name (…/dark), so
-- shot_run_files keeps its (run_id, slot) key and shot_artifacts' unique key
-- gains the theme.
ALTER TABLE shot_run_files ADD COLUMN IF NOT EXISTS theme VARCHAR(8) NOT NULL DEFAULT 'light';
ALTER TABLE shot_artifacts ADD COLUMN IF NOT EXISTS theme VARCHAR(8) NOT NULL DEFAULT 'light';
DO $$
DECLARE old_constraint text;
BEGIN
  -- The old six-column unique on shot_artifacts, found by its definition,
  -- gives way to one that knows the theme.
  FOR old_constraint IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'shot_artifacts'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE '%story_id%viewport%side%variant%media%'
       AND pg_get_constraintdef(oid) NOT LIKE '%theme%'
  LOOP
    EXECUTE format('ALTER TABLE shot_artifacts DROP CONSTRAINT %I', old_constraint);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_run_files'::regclass AND conname = 'shot_run_files_theme_check'
  ) THEN
    ALTER TABLE shot_run_files
      ADD CONSTRAINT shot_run_files_theme_check
      CHECK (theme IN ('light', 'dark') AND (theme = 'light' OR (variant = 'context' AND media = 'png')));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'shot_artifacts'::regclass AND conname = 'shot_artifacts_theme_check'
  ) THEN
    ALTER TABLE shot_artifacts
      ADD CONSTRAINT shot_artifacts_theme_check
      CHECK (theme IN ('light', 'dark') AND (theme = 'light' OR (variant = 'context' AND media = 'png')));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS shot_artifacts_slot_key
  ON shot_artifacts(run_id, story_id, viewport, side, variant, media, theme);
COMMENT ON TABLE shot_run_files IS 'staging:private';

-- #2377: experimental Global Chat. These records are deliberately separate
-- from repository-development chat_sessions and user_agent_preferences: the
-- inexpensive global assistant may discover and operate the product, while
-- code work continues to use the independently configured development agent.
-- The optional spend cap is measured against UTC calendar-month usage.
CREATE TABLE IF NOT EXISTS global_chat_profiles (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  model_id            VARCHAR(255) NOT NULL,
  reasoning_effort    VARCHAR(16) NOT NULL DEFAULT 'low',
  spend_cap_usd       NUMERIC(18,8),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT global_chat_profiles_model_check
    CHECK (model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'),
  CONSTRAINT global_chat_profiles_reasoning_check
    CHECK (reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  CONSTRAINT global_chat_profiles_spend_cap_check
    CHECK (spend_cap_usd IS NULL OR spend_cap_usd >= 0)
);
ALTER TABLE global_chat_profiles
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON TABLE global_chat_profiles IS 'staging:private';

CREATE TABLE IF NOT EXISTS global_chat_threads (
  id              UUID PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary         TEXT,
  summary_cursor  BIGINT,
  active_turn_id  UUID,
  active_turn_started_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at     TIMESTAMPTZ
);
ALTER TABLE global_chat_threads ADD COLUMN IF NOT EXISTS active_turn_id UUID;
ALTER TABLE global_chat_threads ADD COLUMN IF NOT EXISTS active_turn_started_at TIMESTAMPTZ;
-- #2543: chats are durable sessions in Improve, not a single replaceable
-- full-application mode. Drop the original one-live-thread constraint so a
-- user can keep and resume several conversations. Rows archived by the old
-- replacement flow stay archived; deletion remains the only user-facing
-- removal operation.
DROP INDEX IF EXISTS global_chat_threads_one_active_user;
CREATE INDEX IF NOT EXISTS global_chat_threads_user_updated
  ON global_chat_threads (user_id, updated_at DESC);
COMMENT ON TABLE global_chat_threads IS 'staging:private';

CREATE TABLE IF NOT EXISTS global_chat_messages (
  id                  BIGSERIAL PRIMARY KEY,
  thread_id           UUID NOT NULL REFERENCES global_chat_threads(id) ON DELETE CASCADE,
  role                VARCHAR(16) NOT NULL,
  plain_text          TEXT NOT NULL DEFAULT '',
  structured_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_version      VARCHAR(64),
  model_id            VARCHAR(255),
  reasoning_effort    VARCHAR(16),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT global_chat_messages_role_check
    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT global_chat_messages_reasoning_check
    CHECK (reasoning_effort IS NULL
           OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh'))
);
CREATE INDEX IF NOT EXISTS global_chat_messages_thread_cursor
  ON global_chat_messages (thread_id, id DESC);
COMMENT ON TABLE global_chat_messages IS 'staging:private';

CREATE TABLE IF NOT EXISTS global_chat_tool_runs (
  id                    UUID PRIMARY KEY,
  thread_id             UUID NOT NULL REFERENCES global_chat_threads(id) ON DELETE CASCADE,
  message_id            BIGINT REFERENCES global_chat_messages(id) ON DELETE SET NULL,
  capability_id         VARCHAR(120) NOT NULL,
  normalized_input      JSONB NOT NULL DEFAULT '{}'::jsonb,
  bounded_model_result  JSONB,
  authoritative_result  JSONB,
  renderer              VARCHAR(40),
  classic_path          VARCHAR(512),
  status                VARCHAR(16) NOT NULL DEFAULT 'pending',
  duration_ms           INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT global_chat_tool_runs_status_check
    CHECK (status IN ('pending', 'completed', 'failed')),
  CONSTRAINT global_chat_tool_runs_duration_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS global_chat_tool_runs_thread_created
  ON global_chat_tool_runs (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS global_chat_tool_runs_message
  ON global_chat_tool_runs (message_id) WHERE message_id IS NOT NULL;
COMMENT ON TABLE global_chat_tool_runs IS 'staging:private';

-- Only the SHA-256 hash of the bearer confirmation token is stored. A token
-- binds the authenticated user, thread, exact normalized input and observed
-- object revision, and can be consumed once before its short expiry.
CREATE TABLE IF NOT EXISTS global_chat_action_tokens (
  id                UUID PRIMARY KEY,
  token_hash        VARCHAR(64) NOT NULL UNIQUE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id         UUID NOT NULL REFERENCES global_chat_threads(id) ON DELETE CASCADE,
  capability_id     VARCHAR(120) NOT NULL,
  normalized_input  JSONB NOT NULL,
  input_hash        VARCHAR(64) NOT NULL,
  object_revision   VARCHAR(255),
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT global_chat_action_tokens_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$' AND input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT global_chat_action_tokens_expiry_check
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS global_chat_action_tokens_user_expiry
  ON global_chat_action_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL;
COMMENT ON TABLE global_chat_action_tokens IS 'staging:private';

CREATE TABLE IF NOT EXISTS global_chat_usage (
  id                UUID PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id         UUID REFERENCES global_chat_threads(id) ON DELETE SET NULL,
  message_id        BIGINT REFERENCES global_chat_messages(id) ON DELETE SET NULL,
  provider          VARCHAR(32) NOT NULL DEFAULT 'openrouter',
  requested_model   VARCHAR(255),
  served_model      VARCHAR(255),
  reasoning_effort  VARCHAR(16),
  input_tokens      BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens     BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens  BIGINT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(18,8),
  cost_source       VARCHAR(32) NOT NULL DEFAULT 'unavailable',
  outcome           VARCHAR(16) NOT NULL DEFAULT 'unknown',
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  error_code        VARCHAR(64),
  duration_ms       INTEGER,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT global_chat_usage_counts_check
    CHECK (input_tokens >= 0 AND cached_input_tokens >= 0
           AND output_tokens >= 0 AND reasoning_tokens >= 0
           AND attempt_number > 0 AND tool_calls >= 0
           AND (cost_usd IS NULL OR cost_usd >= 0)
           AND (duration_ms IS NULL OR duration_ms >= 0)),
  CONSTRAINT global_chat_usage_reasoning_check
    CHECK (reasoning_effort IS NULL
           OR reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')),
  CONSTRAINT global_chat_usage_cost_source_check
    CHECK (cost_source IN ('provider_reported', 'catalog_estimate', 'unavailable')),
  CONSTRAINT global_chat_usage_outcome_check
    CHECK (outcome IN ('success', 'error', 'cancelled', 'refusal', 'unknown'))
);
CREATE INDEX IF NOT EXISTS global_chat_usage_user_created
  ON global_chat_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS global_chat_usage_thread_created
  ON global_chat_usage (thread_id, created_at DESC) WHERE thread_id IS NOT NULL;
COMMENT ON TABLE global_chat_usage IS 'staging:private';

-- ────────────────────────────────────────────────────────────────────
-- EVERYTHING BELOW THIS LINE MUST STAND UP ON ITS OWN.
--
-- Two tests read this file, cut it at a marker near the top of one of the
-- blocks below, and EXECUTE everything from there to the end of the file
-- against a disposable schema holding nothing but their own stub tables:
-- tests/account-email.test.js. So a
-- statement down here has to run with no `apps`, no `users` and nothing
-- else the platform has. A new table carrying a foreign key belongs ABOVE
-- this line.
--
-- Getting it wrong is invisible locally — both tests skip without a real
-- PostgreSQL — and only turns red on staging, after the proposal is filed.
--
-- The markers are matched by exact text, so do not quote them in a comment
-- either: an earlier copy of this warning named one verbatim and moved the
-- cut up into itself.
-- ────────────────────────────────────────────────────────────────────

-- #1841: private, user-bound mailbox proof, separate from sign-in OTPs.
CREATE TABLE IF NOT EXISTS account_email_verifications (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  code_hash TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  previous_email VARCHAR(255),
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE account_email_verifications IS 'staging:private';

-- #5281: the same user-bound proof for a USERNAME CHANGE on an account with no
-- password (it signs in with an emailed code, so it has no password to give
-- POST /api/me/username). Its own table, not a purpose column on the one
-- above: that one is keyed by user_id alone, so an email change in flight and
-- a rename in flight would overwrite each other's code, and keeping the two
-- proofs in two tables is what makes a code minted for one useless for the
-- other. Sign-in codes (mobile_otp_codes) are keyed by address and never read
-- here. One live code per account, only its bcrypt hash, five guesses, ten
-- minutes, and bound to the confirmed address and the password hash it was
-- minted against: a code outlives neither a new address nor a new password.
CREATE TABLE IF NOT EXISTS account_username_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  code_hash TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE account_username_codes IS 'staging:private';

-- ── Demo mode ──────────────────────────────────────────────────────────
--
-- A recording of the proposal flow needs a second participant who proposes
-- and votes on cue, and a way to put the app back afterwards. That
-- participant is a SYNTHETIC user: a users row that cannot sign in (random
-- discarded password, no OAuth, and refused by the session middleware and the
-- login route even if a session row somehow named it) and that acts only
-- through routes/demo-mode.js — every route of which checks the app is in
-- demo mode and the caller is its creator and a full platform admin. It
-- counts for nothing on an app that is not in demo mode.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT FALSE;
-- The per-app switch, its partner, and where main stood when it was switched
-- on — which is what a reset puts main back to.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS demo_mode BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS demo_partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS demo_base_sha VARCHAR(40);
-- What the app's approvals rule was before demo mode changed it, so switching
-- demo mode off puts it back. NULL while demo mode is off; NULL while it is ON
-- means the app was on the default (timed) strategy, which is the common case.
-- Demo mode sets apps.approvals_required so the vote card reads "1 of 2
-- approvals" instead of counting down a lazy-consensus window nobody in a
-- recording waits out; the column it overwrites is a governance setting, so it
-- is restored rather than cleared.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS demo_prev_approvals INTEGER;

-- #1688: warmer voting.
--
-- pr_votes.reason — the sentence behind a vote. routes/votes.js requires one
-- on a No and accepts one on a Yes; a row written before this column, or a
-- Yes cast without a line, is NULL and reads exactly as it did. The upsert
-- keeps an earlier line when the same person re-casts the same side without
-- a new one, which is what carries a Yes onto a proposal's next version.
ALTER TABLE pr_votes ADD COLUMN IF NOT EXISTS reason TEXT;
-- #2603: the same line, on a governance vote. The governance machine requires one on
-- a No (`down`) and accepts one on a Yes (`up`), with the identical 280-char
-- cap; a row written before this column is NULL and reads exactly as it did.
-- An issue vote toggles OFF when it is re-cast on the same side, so there is
-- no same-side upsert to carry a line across: a flip simply replaces it, the
-- old sentence having argued for the other side.
ALTER TABLE issue_votes ADD COLUMN IF NOT EXISTS reason TEXT;
-- chat_sessions.conversation_prompted_epoch — the approval epoch for which
-- the "needs a conversation" prompt was posted into the proposal's thread.
-- Contested is derived from the active-user count, which moves without a
-- vote, so the prompt is claimed once per epoch here rather than re-posted
-- on every crossing; a new authored push bumps the epoch and earns a new one.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS conversation_prompted_epoch INTEGER;
-- apps.weekly_digest_at — when the "this week" card last went to the app's
-- general chat (services/weekly-digest.js). NULL until the first one.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS weekly_digest_at TIMESTAMPTZ;

-- #2563: users.needs_username_choice — this account has never picked the
-- handle other members see, so the shell must ask before it lets them in.
--
-- SERVER STATE, deliberately. The alternative was for the client to look at
-- the stored username and guess "that looks like an email address", which
-- makes every surface that renders a handle a second implementation of the
-- gate and gets a member called `ada.lovelace` wrong. One column, written
-- where the account is created, read by /api/auth/me and cleared by
-- POST /api/me/username/choose.
--
-- FALSE for everyone the column is added to, then the one-time backfill in
-- src/db/migrate.js turns it on for the accounts email sign-up gave their
-- own email address as a username. That backfill matches
-- `lower(username) = lower(email)` — an exact identity, not a shape test —
-- so an account that merely has a dotted handle is left alone.
ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_username_choice BOOLEAN NOT NULL DEFAULT FALSE;

-- A merged commit of the platform's own app that has not become the running
-- release (services/release-watch.js). The self-hosted row's main_sha is the
-- RUNNING build (seedSelfApp writes GIT_SHA at boot), and GitHub's main is
-- what should be running; everything between the two — the Actions image
-- build, the Helm release, Argo CD, the rollout — is outside the platform,
-- and when a link in it fails the merge reads "merged" here while production
-- serves the previous commit. #2589 sat like that for half an hour because
-- one registry connection dropped during the image build. The drift poller
-- watches the gap and records here what it found, once, so the group chat,
-- the admins' notifications and the board banner can say so.
--
-- NULL when the running build is at main (or ahead of a superseded record).
-- Otherwise one JSON record:
--   sha          the merged commit that has not been released
--   prNumber     the PR that merged it, from the squash subject; may be null
--   kind         'workflow_failed'  the release workflow concluded red
--                'workflow_running' still running long past the normal time
--                'rollout_missing'  the workflow published, nothing rolled
--                'unknown'          past the grace with no workflow to read
--   since        when main moved to the commit (ISO)
--   detectedAt   when this record was written (ISO)
--   running      the build that was serving when it was written
--   runUrl       the workflow run on GitHub, when one was found
--   runStatus / runConclusion   the run's own words, when found
-- Only the self-hosted row ever carries one; a child app's merges deploy
-- through deployProduction and record their failures on last_failure.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS release_stall JSONB;

-- The release workflow's run for main's tip, as the drift poller last read
-- it while main was ahead of the running build (services/release-watch.js
-- recordRun), so every process can say when the next release goes live
-- ("Merged; goes live in the next release (about 8 minutes)") without asking
-- GitHub per viewer. Self-hosted row only; NULL when no run was listed (no
-- run yet, or a token that cannot read Actions) and once the running build
-- is main again. One JSON record:
--   sha          main's tip when it was read
--   status       the run's own status: queued, in_progress, completed, ...
--   conclusion   success, failure, ... once completed
--   startedAt    when the run started (ISO), as GitHub says
--   completedAt  when a completed run finished (ISO)
--   readAt       when the poller read it (ISO)
ALTER TABLE apps ADD COLUMN IF NOT EXISTS release_run JSONB;

-- #2684: the Homeroom bot (`homeroom_bot`, a synthetic user) triages open
-- requests in shadow mode: it reads an issue, its discussion and the app's
-- repository in a read-only scout turn and records ONE verdict per issue —
-- the question it would ask, that the issue is ready to build, or that it
-- needs a person — without posting, claiming, building or notifying. These
-- two tables are the whole of what the bot writes in that mode; the admin
-- console's "Homeroom bot" section reads them.
--
-- homeroom_bot_queue: what it will look at next. One row per (app, issue),
-- refreshed from the GitHub issue cache, drained per app in batches so one
-- worker container per app stays warm across issues. `priority` 0 is an
-- admin's "run now", 1 an issue the bot has never triaged, 2 one whose
-- thread changed since its last run. `thread_seen_at` is the newest thread
-- activity known when the row was queued.
CREATE TABLE IF NOT EXISTS homeroom_bot_queue (
  id             SERIAL PRIMARY KEY,
  app_id         INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number   INTEGER NOT NULL,
  priority       SMALLINT NOT NULL DEFAULT 2,
  reason         TEXT NOT NULL DEFAULT 'refresh',
  thread_seen_at TIMESTAMPTZ,
  requested_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  UNIQUE (app_id, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_queue_order
  ON homeroom_bot_queue(app_id, priority, enqueued_at);

-- homeroom_bot_runs: the ledger and the calibration record. The verdict as
-- the model made it (`determined` / `missing_fact` are the belief model's
-- prior), the text it would have posted, whether a live cap would have
-- suppressed it, what the run cost, and how an admin rated it. Not marked
-- staging:private as a table: the rows derive from public GitHub issues and
-- the platform's own verdicts, a staging preview of the dashboard needs rows
-- to show, and homeroom_bot_posts, the mention opt-outs and bench_tasks all
-- point at it. One of its columns is a person's own words, `plan_change`
-- (from their DM with the bot), and that column is private (below).
CREATE TABLE IF NOT EXISTS homeroom_bot_runs (
  id               SERIAL PRIMARY KEY,
  app_id           INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number     INTEGER NOT NULL,
  session_id       INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  mode             TEXT NOT NULL,
  verdict          TEXT NOT NULL,
  determined       BOOLEAN,
  missing_fact     TEXT,
  question         TEXT,
  question_default TEXT,
  build_note       TEXT,
  reason           TEXT,
  cap_suppressed   TEXT,
  rating           TEXT,
  rating_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating_note      TEXT,
  rated_at         TIMESTAMPTZ,
  posted_at        TIMESTAMPTZ,
  thread_seen_at   TIMESTAMPTZ,
  model            TEXT,
  cost_usd         NUMERIC(18,8),
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  duration_ms      INTEGER,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT homeroom_bot_runs_verdict_check
    CHECK (verdict IN ('question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise')),
  CONSTRAINT homeroom_bot_runs_rating_check
    CHECK (rating IS NULL OR rating IN ('yes', 'no'))
);
-- #2742: which limit stopped the turn, when one did — 'wall clock' or
-- 'input tokens'. A budget stop is not a failure in the same sense (the turn
-- was working and we ended it), so it needs to be findable on its own rather
-- than by grepping the error text, which would break the first time the
-- message is reworded. Deliberately NOT a CHECK: the set is expected to grow
-- (a per-run cost ceiling is the obvious third) and #2737 already had to
-- widen one constraint on this table.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS budget_stop TEXT;

-- #2737: 'empty' joins the verdicts on a database that predates it, and
-- #3264 adds a follow-up's 'answer' and 'revise' (its "ask" is a 'question'
-- and its hand-off a 'person'; a follow-up row is one with a
-- proposal_session_id whose verdict is not 'ready'). The CREATE TABLE above
-- already names them, so this is only for an existing deployment; widening
-- a CHECK can never reject a row already stored.
DO $$
BEGIN
  ALTER TABLE homeroom_bot_runs DROP CONSTRAINT IF EXISTS homeroom_bot_runs_verdict_check;
  ALTER TABLE homeroom_bot_runs ADD CONSTRAINT homeroom_bot_runs_verdict_check
    CHECK (verdict IN ('question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise'));
END $$;

CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_issue
  ON homeroom_bot_runs(app_id, issue_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_created
  ON homeroom_bot_runs(created_at DESC);

-- #3146: live mode. The run a ready verdict turned into a proposal points at
-- that proposal's session.
ALTER TABLE homeroom_bot_runs
  ADD COLUMN IF NOT EXISTS proposal_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;

-- Shadow builds: a ready verdict on an app outside the live list, built on a
-- branch nobody is shown, so what the bot would have proposed can be
-- spot-checked (see "The build lane" in services/homeroom-bot.js).
-- build_ok is NULL on a run that was not built; the branch stays on the
-- app's repository after the session is archived.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_ok BOOLEAN;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_branch TEXT;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_sha TEXT;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_commits INTEGER;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_error TEXT;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_cost_usd NUMERIC(18,8);
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_at TIMESTAMPTZ;
-- The build lane's queue is the runs themselves: queued (build_queued_at
-- set, build_at NULL), building (build_at set, build_ok NULL), then built
-- or failed. build_attempts counts claims, so a build a restart interrupted
-- is retried once and then recorded failed.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_queued_at TIMESTAMPTZ;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_attempts INTEGER NOT NULL DEFAULT 0;
-- The spec the bot wrote just before building (live or shadow): the same
-- text is the build session's spec doc; kept here for the dashboard and the
-- export, since a shadow build's session is archived and nobody opens it.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_spec_md TEXT;
-- The HTML document of the kept plan (#3699), when it was written as one, so
-- a build that carries on from it publishes it whole.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_spec_html TEXT;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_build_queue
  ON homeroom_bot_runs(app_id, build_queued_at)
  WHERE build_queued_at IS NOT NULL AND build_ok IS NULL;

-- Everything the bot posted on an issue: one row per post, both surfaces
-- (the GitHub comment and the Homeroom thread message) on the same row.
-- The partial unique index is what makes "looking at this" a once-per-issue
-- post: the insert IS the claim, so two passes cannot both announce it.
CREATE TABLE IF NOT EXISTS homeroom_bot_posts (
  id                 SERIAL PRIMARY KEY,
  app_id             INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number       INTEGER NOT NULL,
  run_id             INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL,
  github_comment_id  BIGINT,
  thread_message_id  INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_homeroom_bot_posts_looking
  ON homeroom_bot_posts(app_id, issue_number) WHERE kind = 'looking';
-- TRUE while the post is going out (live.post), NULL once it has, and for
-- every post from before: a durable build a restart caught in the middle of
-- one says it again, taking up this row and sending only what had not gone.
ALTER TABLE homeroom_bot_posts ADD COLUMN IF NOT EXISTS pending BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_posts_issue
  ON homeroom_bot_posts(app_id, issue_number, created_at DESC);

-- Who asked the Homeroom bot to stop tagging them on an issue. The bot's
-- posts @-mention whoever filed the issue and the people who took part in
-- its discussion; a person here is left out of that issue's mentions from
-- then on. Recorded from the triage or follow-up turn that read the ask.
CREATE TABLE IF NOT EXISTS homeroom_bot_mention_optouts (
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number  INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id        INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, issue_number, user_id)
);

-- #3624: the bot in a DM (services/homeroom-bot-dm.js).
--
-- A triage question's suggested answers, the default first: what the DM
-- offers to tap. NULL on every other verdict and on a run before #3624.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS question_answers JSONB;

-- Who each request the live loop looked at is FOR: whoever filed it, or the
-- creator a project's first version was filed for. Its questions and its
-- outcome reach that person's DM, and its runs count against their weekly
-- Homeroom bot allowance.
CREATE TABLE IF NOT EXISTS homeroom_bot_requesters (
  app_id         INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number   INTEGER NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_title    TEXT,
  first_version  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_requesters_user
  ON homeroom_bot_requesters(user_id);

-- 16 Oct 2026: which of the requests the bot tracks have closed, whether or
-- not Homeroom keeps a row of its own for them (issues). A request filed
-- through Suggest an improvement or a comment pin has none, so its close
-- reached nothing the bot reads: #4752 stayed in the Needs you of its
-- requester's activity drawer days after it closed. Written when a merged
-- change or a passed close vote closes one (noteRequestsClosed), and by the
-- refresh's reconcile once GitHub confirms a close by hand
-- (homeroom-bot-closed-requests.js closeRequestRows), which also writes a row
-- with no `closed_at` for a request it asked about that was not closed, so
-- the next refresh asks about the others first. A request back on the open
-- list loses its row. Read beside issues.status wherever the bot decides a
-- request is closed (the tray, the track, progress, the abandoned builds).
CREATE TABLE IF NOT EXISTS homeroom_bot_closed_requests (
  app_id         INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number   INTEGER NOT NULL,
  -- When it was seen closed; NULL: GitHub did not report it closed when the
  -- reconcile last asked (checked_at).
  closed_at      TIMESTAMPTZ,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, issue_number)
);
-- B4: what the person asked for, in their own words: their message to the
-- bot that the request was filed from, the description they wrote when they
-- asked for a change, or a first version's brief. Their activity card leads
-- with it ("You asked: ..."), and the bot's change credits them by it. The
-- issue's title stays the bot's short name for it.
ALTER TABLE homeroom_bot_requesters ADD COLUMN IF NOT EXISTS asked_text TEXT;
-- Their own words, often from their DM with the bot: not copied to staging.
COMMENT ON COLUMN homeroom_bot_requesters.asked_text IS 'staging:private';

-- B5: the bot is introduced once per person, ever: a maker at their first
-- project, anybody else at their first request. Claimed by inserting the
-- row, so two devices or a retry never greet twice. `kind` is 'maker',
-- 'member', or 'known' for somebody the bot had already written to before
-- greetings existed (no hello for them).
CREATE TABLE IF NOT EXISTS homeroom_bot_hellos (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  message_id  INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT homeroom_bot_hellos_kind_check CHECK (kind IN ('maker', 'member', 'known'))
);
COMMENT ON TABLE homeroom_bot_hellos IS 'staging:private';
-- WP-F: somebody who joins by an invite link is greeted as a 'joiner'
-- (homeroom-bot-dm.js greetJoiner). Everybody who had platform access when
-- the bot went on for everyone, and had not met it, was greeted once as a
-- 'welcome' (a leader sweep, done on 2026-10-09 and deleted since). #4604: somebody who ends the
-- welcome tour without having met it is greeted as a 'tour'
-- (homeroom-bot-dm.js greetTourFinisher).
DO $$
BEGIN
  ALTER TABLE homeroom_bot_hellos DROP CONSTRAINT IF EXISTS homeroom_bot_hellos_kind_check;
  ALTER TABLE homeroom_bot_hellos ADD CONSTRAINT homeroom_bot_hellos_kind_check
    CHECK (kind IN ('maker', 'member', 'joiner', 'welcome', 'tour', 'known'));
END $$;
-- B5: the name people see the bot by. Its username stays homeroom_bot.
UPDATE users SET display_name = 'Homeroom bot'
 WHERE username = 'homeroom_bot' AND is_synthetic = TRUE AND display_name IS DISTINCT FROM 'Homeroom bot';

-- Every DM message the bot sent about a request, so a person's reply can
-- be posted on the right request. A question is a row whose
-- question_status is set: open until answered, or closed by newer news on
-- the same request. Private: it indexes direct messages.
CREATE TABLE IF NOT EXISTS homeroom_bot_dm_messages (
  message_id         INTEGER PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  app_id             INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number       INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  run_id             INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL,
  question_status    TEXT,
  answer_message_id  INTEGER,
  answered_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT homeroom_bot_dm_messages_status_check
    CHECK (question_status IS NULL OR question_status IN ('open', 'answered', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_dm_messages_open
  ON homeroom_bot_dm_messages(user_id, created_at DESC) WHERE question_status = 'open';
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_dm_messages_issue
  ON homeroom_bot_dm_messages(user_id, app_id, issue_number);
COMMENT ON TABLE homeroom_bot_dm_messages IS 'staging:private';

-- A project created with a description ("What should it do?" in the create
-- dialog): filed as the project's first request, under its creator's name,
-- once the project is running (waiting, then filing, then filed; failed
-- after three tries). `bot_builds` says whether the Homeroom bot builds it:
-- true when the creator is somebody the bot talks to in a DM, and then the
-- bot acts live on the project while they are on the DM list; false for
-- everybody else, whose request is filed and left to the group. Private:
-- the brief is what the person typed, before they chose to post it
-- anywhere.
CREATE TABLE IF NOT EXISTS homeroom_bot_first_versions (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brief         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting',
  issue_number  INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filed_at      TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_first_versions_status_check
    CHECK (status IN ('waiting', 'filing', 'filed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_first_versions_waiting
  ON homeroom_bot_first_versions(created_at) WHERE status = 'waiting';
COMMENT ON TABLE homeroom_bot_first_versions IS 'staging:private';
-- Every row before the column was one the bot builds, so the default is true.
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS bot_builds BOOLEAN NOT NULL DEFAULT TRUE;
-- Run six (14 Oct 2026): whether its maker is told when it is ready and
-- live ("We'll tell you when it's live" under its plan in their chat with
-- Homeroom bot). On from Make it; off, those two are said in the chat and
-- ring nothing (services/homeroom-bot-dm.js firstVersionNotify).
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS notify_live BOOLEAN NOT NULL DEFAULT TRUE;
-- The plan written at Make it (services/first-version-plan.js), while the
-- project is still being set up: one model call from the description, in
-- the shape a first version's triage gives (`plan` bullets, up to two
-- `questions` with the suggested answer first, the build note). When the
-- bot comes to its request it builds from this plan rather than reading
-- the request again (homeroom-bot.js planFromEarly). `early_plan_status`
-- is pending while the call runs, ready with a plan, failed without one
-- (then the triage plans it as before); null when none was asked for.
-- `answers` are what its maker chose on the made screen, in question
-- order, and `answered_at` when the plan was decided (Submit, Build it, or
-- a plan with nothing to ask). Private, as the brief is.
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS early_plan JSONB;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS early_plan_status TEXT;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS early_plan_at TIMESTAMPTZ;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS early_plan_error TEXT;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS answers JSONB;
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;
DO $$
BEGIN
  ALTER TABLE homeroom_bot_first_versions DROP CONSTRAINT IF EXISTS homeroom_bot_first_versions_early_plan_check;
  ALTER TABLE homeroom_bot_first_versions ADD CONSTRAINT homeroom_bot_first_versions_early_plan_check
    CHECK (early_plan_status IS NULL OR early_plan_status IN ('pending', 'ready', 'failed'));
END $$;
-- The SHAPE of a reply the plan at Make it could not use (early_plan_error
-- 'unusable_reply', first-version-plan.js replyShape), never its words: how
-- far it got as JSON (`json`), why it was refused (`why`), its top-level
-- keys with each value's type and length (`keys`), the length of its text
-- and of the model's own text beside its tool call, how many tool calls it
-- made, and its finish reason. Null for a plan that was used.
ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS early_plan_reply JSONB;

-- The first session's sketch (services/app-sketch.js): since 5 October 2026
-- a featured card of the idea, made from its description a few seconds after
-- Make it and shown on the made screen while the real app is built. `design`
-- holds the card (kind 'card': emoji, tagline, points), committed to the
-- repository as design/sketch.json; its emoji becomes the project's icon.
-- `html` is only set on the screen mocks made before it (sanitized markup,
-- no longer shown). One per project.
CREATE TABLE IF NOT EXISTS app_sketches (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'ready', 'failed')),
  design        JSONB,
  html          TEXT,
  model         TEXT,
  error         TEXT,
  committed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at      TIMESTAMPTZ
);
COMMENT ON TABLE app_sketches IS 'staging:private';

-- A project somebody the bot works for made with no description to build
-- from: imported from GitHub, forked, or created without one (a connector
-- or the API). Nothing is filed for it. An import's created_at is where its
-- backlog ends: the issues it arrived with wait until something happens on
-- them (homeroom-bot.js refreshApp).
CREATE TABLE IF NOT EXISTS homeroom_bot_dm_projects (
  app_id      INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT homeroom_bot_dm_projects_origin_check
    CHECK (origin IN ('import', 'fork', 'blank'))
);
COMMENT ON TABLE homeroom_bot_dm_projects IS 'staging:private';

-- The bot fixing its own failing checks: the head commit a checks
-- follow-up looked at, on the run that recorded it (a revision, a hand-off
-- to a person, or a turn that failed), so each failing head gets one look.
-- NULL on every other run.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS checks_head_sha TEXT;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_proposal
  ON homeroom_bot_runs(proposal_session_id) WHERE proposal_session_id IS NOT NULL;
-- The verdicts export says, per run, whether its news reached the
-- requester's DM and whether they answered it there.
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_dm_messages_run
  ON homeroom_bot_dm_messages(run_id) WHERE run_id IS NOT NULL;

-- #3654: what a run can be replayed from. Every triage, follow-up,
-- checks fix and build stores the text its model read (the seed, the frozen
-- request thread as JSON, the whole prompt, and a stage's own inputs such as
-- the spec or the failing checks), the commit the stage ran against and a
-- hash of the prompt, so the benchmark (services/bench/) can run the same
-- input through another model. Text is gzip-compressed and stored once per
-- distinct content (homeroom_bot_snapshot_blobs, keyed by its sha256), and
-- each text is capped (services/homeroom-bot-snapshots.js). Private: it is
-- request and DM text, private apps' included.
CREATE TABLE IF NOT EXISTS homeroom_bot_snapshot_blobs (
  hash        TEXT PRIMARY KEY,
  content     BYTEA NOT NULL,
  chars       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE homeroom_bot_snapshot_blobs IS 'staging:private';
CREATE TABLE IF NOT EXISTS homeroom_bot_run_snapshots (
  id            SERIAL PRIMARY KEY,
  -- NULL for a snapshot imported from a merged pull request rather than
  -- recorded by a run; kept when its run is deleted.
  run_id        INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL,
  stage         TEXT NOT NULL,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number  INTEGER NOT NULL,
  base_sha      TEXT,
  prompt_hash   TEXT,
  -- name to blob hash: seed, thread, prompt, and a stage's own inputs.
  texts         JSONB NOT NULL DEFAULT '{}',
  -- Small, structured inputs (a flag, a count, a model id).
  extra         JSONB NOT NULL DEFAULT '{}',
  truncated     BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT NOT NULL DEFAULT 'run',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT homeroom_bot_run_snapshots_stage_check
    CHECK (stage IN ('triage', 'spec', 'build', 'followup', 'checks_fix', 'dm')),
  CONSTRAINT homeroom_bot_run_snapshots_source_check
    CHECK (source IN ('run', 'import'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_homeroom_bot_run_snapshots_run_stage
  ON homeroom_bot_run_snapshots(run_id, stage) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_run_snapshots_stage
  ON homeroom_bot_run_snapshots(stage, created_at DESC);
COMMENT ON TABLE homeroom_bot_run_snapshots IS 'staging:private';

-- #3654: the verdict a labeller says was right, beside the yes/no rating
-- (rating_note is no longer erased by a rating), and the model a run's
-- build ran on (per-stage models: it may differ from the triage's).
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS label_verdict TEXT;
DO $$
BEGIN
  ALTER TABLE homeroom_bot_runs DROP CONSTRAINT IF EXISTS homeroom_bot_runs_label_verdict_check;
  ALTER TABLE homeroom_bot_runs ADD CONSTRAINT homeroom_bot_runs_label_verdict_check
    CHECK (label_verdict IS NULL OR label_verdict IN ('question', 'ready', 'person', 'empty', 'answer', 'revise'));
END $$;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_model TEXT;

-- A build turn that ended without failing and changed nothing (live or
-- shadow, homeroom-bot-live.js buildNudgePrompt): { turns: [{ turn
-- ('build' | 'nudge'), ended, said, provider, providers, model, harness,
-- requests, toolCalls, fileEdits, outputTokens, seconds }], nudged,
-- notNudged, committed, recovered }. `said` is the agent's last message,
-- clipped and redacted, kept for admins to read and never quoted to anybody
-- else. It can quote a private project's code: private, as `review` is.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_no_change JSONB;
COMMENT ON COLUMN homeroom_bot_runs.build_no_change IS 'staging:private';

-- A live first version that did not finish and was tried once more on its
-- own, from its plan (homeroom-bot.js buildLive claimAutoRetry): { at, error
-- (why the first try failed), session_id (its session) }. At most one run of
-- a request has it: a first version is retried automatically once.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_retry JSONB;
COMMENT ON COLUMN homeroom_bot_runs.build_retry IS 'staging:private';

-- 15 Oct 2026: a live first version that was built and could not be
-- proposed, finished by its maker's Try again (homeroom-bot.js
-- finishBuiltFirstVersion): the session the build left is proposed as the
-- build would have proposed it. { at, by (who tapped it), session_id (the
-- session it proposes), outcome ('proposed' or 'failed', once known) }.
-- Claimed once per run, so a second tap proposes nothing; a claim with no
-- outcome after FINISH_STALE_MINUTES is a process that died and is taken
-- again. Nothing private: no words, only ids and times.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_finish JSONB;

-- Where a live or shadow build is between its steps, saved at each step
-- boundary so a restart carries it on from there instead of building it
-- again or sending it back to be triaged (homeroom-bot-checkpoint.js):
-- { sessionId, step ('session' | 'spec_turn' | 'spec' | 'build_turn' |
-- 'landed' | 'reviewed' | 'proposed'), at, specVersion, landed { sha,
-- commits, pushOk, text }, reviewed { finalSha, finalCommits, costUsd },
-- prNumber, recovered (what restart recovery found for its last turn),
-- once { debited: { <sessionId>: usd } } }. `text` and `recovered` can
-- quote a private project's code: private, as build_no_change is.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_checkpoint JSONB;
COMMENT ON COLUMN homeroom_bot_runs.build_checkpoint IS 'staging:private';

-- A live build waiting its turn: a live 'ready' verdict is built after the
-- turn that read it ends, up to three builds per project at a time
-- (homeroom-bot.js BUILDS_PER_PROJECT), so reading the project's next
-- request never waits for a build. Set when the verdict is
-- recorded, cleared once the build's session exists (homeroom-bot.js
-- buildLive). The shadow lane's build_queued_at/build_at stay its own.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS live_build_waiting_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS homeroom_bot_runs_live_build_waiting_idx
  ON homeroom_bot_runs(live_build_waiting_at) WHERE live_build_waiting_at IS NOT NULL;
-- When the build went ahead, kept: live_build_waiting_at above is cleared
-- the moment the build starts, so how long it waited for its slot could only
-- be pieced together afterwards (newcomer run five, 13 Oct 2026). Build it
-- (homeroom-bot.js goAhead) sets it; a ready verdict queued with no Build it
-- to wait for (queueLiveBuild) sets it once. Never cleared. The build's own
-- start is its session's created_at (build_session_id), and the gap between
-- the two is logged as waitedMs when it starts.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS go_ahead_at TIMESTAMPTZ;

-- B6: what a look planned, for its person to see before anything is built:
-- { bullets, questions: [{ question, answers }], chosen }. A first version's
-- plan (3 to 5 plain bullets and up to 2 choices, each with its suggested
-- answer first) waits for its creator's Build it: its run waits with
-- `awaiting_go_at` instead of live_build_waiting_at, which Build it then
-- sets with the answers chosen written into build_note. A request the read
-- has two questions about keeps them here too. `plan_change` is what the
-- creator asked the plan changed with (Change something), in their words,
-- for the next look at the request; it is never posted anywhere.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS plan JSONB;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS awaiting_go_at TIMESTAMPTZ;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS plan_change TEXT;
COMMENT ON COLUMN homeroom_bot_runs.plan_change IS 'staging:private';
CREATE INDEX IF NOT EXISTS homeroom_bot_runs_awaiting_go_idx
  ON homeroom_bot_runs(awaiting_go_at) WHERE awaiting_go_at IS NOT NULL;
-- #4175: a first version's plan that could not be sent keeps its run
-- waiting (awaiting_go_at) and is tried again on later wakes, a few times
-- over about an hour (homeroom-bot.js retryUnsentPlans), never built without
-- its creator's Build it. `plan_send_attempts` counts the sends tried;
-- `plan_unsent_at` is when the last one failed, NULL once one reached them.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS plan_send_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS plan_unsent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS homeroom_bot_runs_plan_unsent_idx
  ON homeroom_bot_runs(plan_unsent_at) WHERE plan_unsent_at IS NOT NULL;
-- #4239: a `person` verdict whose request is about the Homeroom platform
-- itself rather than the project it was filed on (the triage's `platform`
-- flag). Its requester is offered to move it to Homeroom's own board.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS about_platform BOOLEAN;
-- What became of that offer, for the console and get_homeroom_bot
-- (homeroom-bot-move.js noteMoveOffer): 'sent'; or why none went out:
-- 'no_requester' (nobody is known to have asked for it), 'no_bot' (its
-- requester does not have the bot), 'repeat_held' (the note was not said
-- again: nobody addressed the bot since the last one), 'already_offered'
-- (they were offered it before), 'not_sent' (the DM did not go out). NULL
-- on a run from before this was recorded.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS move_offer TEXT;
-- #4488: a `ready` verdict on an existing project the triage labelled
-- complicated (a new screen or kind of thing, a change to how people get
-- around or what it stores, two quite different ways to do it, or large).
-- Its spec is drafted first and shown to its requester, whose Build it
-- builds exactly that spec (`plan` holds { complicated, spec: { sessionId,
-- version } }), and its screens are reviewed once it is built.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS complicated BOOLEAN;

-- B9: a request asked for in a project's group chat, by mentioning Homeroom
-- bot or by "Make this a request" on your own message. The message stays
-- the person's own, and the bot writes nothing into the chat: how it is
-- going rides on the message's metadata (`botRequest`) for everyone, and
-- the card under it is drawn for its requester alone, from these rows
-- (GET /api/apps/:slug/my-bot-requests), never from chat_messages. `kind`:
-- filed (the bot builds it), group (filed for the group, where the bot does
-- not build), unsure (asks the person first), question (pointed at the
-- bot's own chat), dismissed (they said not now), revise (a fix asked for
-- on one of the bot's own changes still waiting for approval, sent to that
-- change rather than filed as a new request).
CREATE TABLE IF NOT EXISTS chat_bot_requests (
  chat_message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  requester_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  issue_number    INTEGER,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_bot_requests_kind_check CHECK (kind IN ('filed', 'group', 'unsure', 'question', 'dismissed', 'offer', 'revise'))
);
-- WP-C: 'offer', a newcomer's message that reads as an idea, offered to them
-- as a request (homeroom-bot-chat.js maybeOffer). Fix in place (5 October):
-- 'revise', a mention asking to fix one of the bot's own changes before it
-- goes live (homeroom-bot-chat.js reviseFromMessage). A table made before
-- either has a narrower check; widen it once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_bot_requests'::regclass
       AND conname = 'chat_bot_requests_kind_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%revise%'
  ) THEN
    ALTER TABLE chat_bot_requests DROP CONSTRAINT chat_bot_requests_kind_check;
    ALTER TABLE chat_bot_requests ADD CONSTRAINT chat_bot_requests_kind_check
      CHECK (kind IN ('filed', 'group', 'unsure', 'question', 'dismissed', 'offer', 'revise'));
  END IF;
END $$;
-- The change a 'revise' row asked about: its card and its chip follow that
-- change (its discussion, its revision, approval, live), not a new request.
ALTER TABLE chat_bot_requests ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chat_bot_requests_requester
  ON chat_bot_requests(requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_bot_requests_issue
  ON chat_bot_requests(app_id, issue_number) WHERE issue_number IS NOT NULL;
COMMENT ON TABLE chat_bot_requests IS 'staging:private';

-- Weekly building time (homeroom-bot-dm.js weeklySpentCents). A run counts
-- toward one person's week only when it is `charged`, and against its
-- `payer`: the person whose action started it (the requester unless
-- somebody else asked the bot to start or change it). A run the bot caused
-- itself (a restart's re-read, a resumed plan, fixing its own failing
-- checks, a shadow run) is not charged. A run with no payer is the
-- requester's, as every run was before.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS charged BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS payer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- A queued request whose payer's week is used up is held until the week
-- resets, keeping its place (enqueued_at), rather than dropped and queued
-- again by every refresh. Who will pay for it, when somebody other than its
-- requester asked for it (the DM's start_request).
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS held_until TIMESTAMPTZ;
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS payer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- #3654: the Homeroom bot's benchmark (services/bench/). A SUITE is a set of
-- tasks drawn from real runs; it is a version (name + version), and freezing
-- it makes its tasks immutable (services/bench/suites.js refuses every write
-- to a frozen suite's tasks; "edit" makes the next version). `frozen` is the
-- versioned core, `rotating` the set refreshed from recent runs.
CREATE TABLE IF NOT EXISTS bench_suites (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  kind        TEXT NOT NULL DEFAULT 'frozen',
  parent_id   INTEGER REFERENCES bench_suites(id) ON DELETE SET NULL,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frozen_at   TIMESTAMPTZ,
  CONSTRAINT bench_suites_kind_check CHECK (kind IN ('frozen', 'rotating')),
  UNIQUE (name, version)
);
COMMENT ON TABLE bench_suites IS 'staging:private';

-- One task: a stage of one recorded run (or a merged pull request), the
-- snapshot it replays, tags to slice results by, and the reference a
-- candidate is graded against. `label_token` is the opaque id a labelling
-- session sees instead of the task's own id. Private: tasks come from any
-- app, private ones included, and the reference is written from them.
CREATE TABLE IF NOT EXISTS bench_tasks (
  id                SERIAL PRIMARY KEY,
  suite_id          INTEGER NOT NULL REFERENCES bench_suites(id) ON DELETE CASCADE,
  stage             TEXT NOT NULL,
  source_run_id     INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL,
  snapshot_id       INTEGER NOT NULL REFERENCES homeroom_bot_run_snapshots(id) ON DELETE CASCADE,
  app_id            INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  issue_number      INTEGER,
  tags              JSONB NOT NULL DEFAULT '{}',
  reference         JSONB NOT NULL DEFAULT '{}',
  reference_source  TEXT,
  labeled_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  labeled_at        TIMESTAMPTZ,
  label_token       TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bench_tasks_stage_check
    CHECK (stage IN ('triage', 'spec', 'build', 'followup', 'checks_fix', 'dm')),
  CONSTRAINT bench_tasks_reference_source_check
    CHECK (reference_source IS NULL OR reference_source IN ('human', 'opus', 'merged_pr', 'authored'))
);
CREATE INDEX IF NOT EXISTS idx_bench_tasks_suite ON bench_tasks(suite_id, stage);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_tasks_suite_run_stage
  ON bench_tasks(suite_id, source_run_id, stage) WHERE source_run_id IS NOT NULL;
COMMENT ON TABLE bench_tasks IS 'staging:private';

-- #3654 Core v1: a reference written into a suite's checked-in definition by
-- its author (the adversarial triage tasks) is 'authored'. Widening a CHECK
-- never rejects a row already stored.
DO $$
BEGIN
  ALTER TABLE bench_tasks DROP CONSTRAINT IF EXISTS bench_tasks_reference_source_check;
  ALTER TABLE bench_tasks ADD CONSTRAINT bench_tasks_reference_source_check
    CHECK (reference_source IS NULL OR reference_source IN ('human', 'opus', 'merged_pr', 'authored'));
END $$;

-- #3654 Core v1: a suite materialized from a checked-in definition
-- (src/services/bench/suites/*.json, services/bench/core.js), one row per
-- definition and version. It is what makes materializing idempotent (a
-- `done` row is never redone unless an admin asks to retry what was
-- skipped), what the Benchmark area reads its status from (`summary`:
-- counts per stage and every skipped task with its reason), and what marks
-- a suite as definition-backed (such a suite freezes only once every task
-- has its reference). Private like the suites themselves.
CREATE TABLE IF NOT EXISTS bench_materializations (
  definition   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  suite_id     INTEGER REFERENCES bench_suites(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  summary      JSONB NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  PRIMARY KEY (definition, version),
  CONSTRAINT bench_materializations_status_check CHECK (status IN ('running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_bench_materializations_suite ON bench_materializations(suite_id);
COMMENT ON TABLE bench_materializations IS 'staging:private';
-- A pass beats while it works, so a row left 'running' by a process that died
-- mid-pass (a redeploy) can be told apart from one still working.
ALTER TABLE bench_materializations ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- The benchmark account's weekly allowance went from $100 to $500 a week
-- (services/bench/runner.js DEFAULT_BENCH_WEEKLY_CENTS): $100 ran out partway
-- through a run on 14 Oct 2026, and every trial after that failed on its
-- first request. The account was made with the old amount, so raise it once.
-- Its included OpenRouter key follows on the bench's next turn
-- (agent-turn resolveCodexRuntimeContext syncs the key's limit). Guarded by a
-- marker row, like weekly_limit_backfilled: an amount an admin sets later in
-- Admin > Limits stays as they set it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'bench_weekly_limit_500') THEN
    UPDATE users
       SET weekly_limit_cents = 50000
     WHERE username = 'homeroom_bench' AND is_synthetic = TRUE
       AND COALESCE(weekly_limit_cents, 0) < 50000;
    INSERT INTO platform_settings (key, value)
      VALUES ('bench_weekly_limit_500', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- #3654: a benchmark RUN puts a suite's tasks for some stages through some
-- models, `repeats` times each (a build once), within a dollar cap. Its
-- TRIALS are one task on one model, one attempt: pending, running, then how
-- it ended. `ok` means the stage produced an answer to grade; a model that
-- produced nothing usable is `model_fail`; a platform fault is `infra_fail`
-- and is kept out of quality; `not_applicable` is a task the model cannot
-- take (its stage or its context window); `skipped_cap` is what the cap left
-- unrun. `item_token` is the opaque id a grading session sees: never the
-- trial id, never the model.
CREATE TABLE IF NOT EXISTS bench_runs (
  id              SERIAL PRIMARY KEY,
  suite_id        INTEGER NOT NULL REFERENCES bench_suites(id) ON DELETE CASCADE,
  models          TEXT[] NOT NULL,
  baseline_model  TEXT,
  stages          TEXT[] NOT NULL,
  repeats         INTEGER NOT NULL DEFAULT 3,
  cap_usd         NUMERIC(12,4) NOT NULL DEFAULT 50,
  concurrency     INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'queued',
  spent_usd       NUMERIC(18,8) NOT NULL DEFAULT 0,
  note            TEXT,
  started_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  CONSTRAINT bench_runs_status_check
    CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'capped'))
);
CREATE INDEX IF NOT EXISTS idx_bench_runs_open ON bench_runs(id) WHERE status IN ('queued', 'running');
COMMENT ON TABLE bench_runs IS 'staging:private';

CREATE TABLE IF NOT EXISTS bench_trials (
  id              SERIAL PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
  task_id         INTEGER NOT NULL REFERENCES bench_tasks(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending',
  item_token      TEXT NOT NULL UNIQUE,
  claims          INTEGER NOT NULL DEFAULT 0,
  est_cost_usd    NUMERIC(12,4),
  raw_output      TEXT,
  parsed          JSONB,
  cost_usd        NUMERIC(18,8),
  input_tokens    BIGINT,
  output_tokens   BIGINT,
  duration_ms     INTEGER,
  session_id      INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  base_sha        TEXT,
  build_branch    TEXT,
  build_sha       TEXT,
  build_commits   INTEGER,
  diff            TEXT,
  changed_files   JSONB,
  checks          JSONB,
  deterministic   JSONB,
  error           TEXT,
  branch_deleted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  CONSTRAINT bench_trials_status_check
    CHECK (status IN ('pending', 'running', 'ok', 'model_fail', 'infra_fail', 'timeout',
                      'not_applicable', 'skipped_cap', 'cancelled')),
  UNIQUE (run_id, task_id, model, attempt)
);
CREATE INDEX IF NOT EXISTS idx_bench_trials_run ON bench_trials(run_id, status);
CREATE INDEX IF NOT EXISTS idx_bench_trials_pending ON bench_trials(run_id, attempt, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bench_trials_branches
  ON bench_trials(finished_at) WHERE build_branch IS NOT NULL AND branch_deleted_at IS NULL;
COMMENT ON TABLE bench_trials IS 'staging:private';
-- A trial a restart interrupted (services/bench/lane.js "After a restart"):
-- what the abandoned attempts spent, charged to the run when each was put
-- back in the queue and kept apart from cost_usd, which is the finishing
-- attempt's own; and when restart recovery finished the trial from its last
-- turn instead of running it again. session_id, base_sha and build_branch
-- are written as soon as they exist, before any turn runs.
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS interrupted_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bench_trials_running_session
  ON bench_trials(session_id) WHERE status = 'running';

-- #3654: a grade of a benchmark trial, by the judge (`opus`: a Claude Opus
-- session on a person's own plan, through the admin-only connector tools) or
-- by a person (`human`: an admin in the console, which overrides the judge).
-- Binary, with the critique the judge wrote first. The deterministic grade
-- lives on the trial itself (bench_trials.deterministic). Several grades of
-- one trial are kept; the latest of each grader counts.
CREATE TABLE IF NOT EXISTS bench_grades (
  id              SERIAL PRIMARY KEY,
  trial_id        INTEGER NOT NULL REFERENCES bench_trials(id) ON DELETE CASCADE,
  grader          TEXT NOT NULL,
  grader_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  grader_label    TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  critique        TEXT,
  criteria        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bench_grades_grader_check CHECK (grader IN ('opus', 'human')),
  CONSTRAINT bench_grades_verdict_check CHECK (verdict = 'pass' OR verdict = 'fail')
);
CREATE INDEX IF NOT EXISTS idx_bench_grades_trial ON bench_grades(trial_id, grader, created_at DESC);
COMMENT ON TABLE bench_grades IS 'staging:private';

-- #3737: the benchmark's taste eval (services/bench/taste.js). Two more
-- task kinds: `first_version`, the bot's whole first-version path (triage
-- note, spec, build) from a brief on today's starter template, and
-- `capture`, an existing app at a commit with no build (the "before" arm).
-- Both end in the screenshot step (services/bench/capture.js). Widening a
-- CHECK never rejects a row already stored.
DO $$
BEGIN
  ALTER TABLE bench_tasks DROP CONSTRAINT IF EXISTS bench_tasks_stage_check;
  ALTER TABLE bench_tasks ADD CONSTRAINT bench_tasks_stage_check
    CHECK (stage IN ('triage', 'spec', 'build', 'followup', 'checks_fix', 'dm', 'first_version', 'capture'));
END $$;
-- What the screenshot step measured, without the images: whether the app
-- booted (and why not), each screenshot's viewport, look and state, the
-- automatic checks as numbers, and the source lint for the known tells.
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS capture JSONB;

-- The screenshots themselves, stored the way the before and after shots are
-- (shot_artifacts): one row per image in a table of their own, never inside
-- the trial's row, and gone with the trial. Read only through the admin
-- console and the admin-only grading tools. Private: an app's screens can
-- show any of its data.
CREATE TABLE IF NOT EXISTS bench_trial_artifacts (
  id            VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  trial_id      INTEGER NOT NULL REFERENCES bench_trials(id) ON DELETE CASCADE,
  shot_id       VARCHAR(64) NOT NULL,
  viewport      VARCHAR(16) NOT NULL,
  look          VARCHAR(8) NOT NULL CHECK (look IN ('light', 'dark')),
  state         VARCHAR(16) NOT NULL CHECK (state IN ('populated', 'empty', 'error', 'loading', 'result')),
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA NOT NULL,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  sha256        VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trial_id, shot_id)
);
COMMENT ON TABLE bench_trial_artifacts IS 'staging:private';
-- 13 Oct 2026: a trial's whole transcript (services/bench/progress.js
-- tracker): every activity line its turns reported, as the studio's watch
-- sees them (the tool each step used, each model request's size and time,
-- its review's rounds), with when it came and the trial's step then, where
-- bench_trials.progress keeps only the last four. A `step` row marks each
-- step's start. Lines restart recovery replayed after the platform went down
-- are marked `replayed` (their time is the replay's). Gone with the trial;
-- private, as its screens are: a line can quote the app's data.
CREATE TABLE IF NOT EXISTS bench_trial_lines (
  id        BIGSERIAL PRIMARY KEY,
  trial_id  INTEGER NOT NULL REFERENCES bench_trials(id) ON DELETE CASCADE,
  at        TIMESTAMPTZ NOT NULL,
  step      VARCHAR(16),
  kind      VARCHAR(8) NOT NULL DEFAULT 'line' CHECK (kind IN ('line', 'step')),
  line      TEXT NOT NULL,
  replayed  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_bench_trial_lines_trial ON bench_trial_lines (trial_id, id);
COMMENT ON TABLE bench_trial_lines IS 'staging:private';
-- A fifth state, `result`: the populated screen after its primary action
-- was tapped once (worker/usernode-bench-capture.js). Widening the CHECK on
-- a table made before it rejects no row already stored.
DO $$
BEGIN
  ALTER TABLE bench_trial_artifacts DROP CONSTRAINT IF EXISTS bench_trial_artifacts_state_check;
  ALTER TABLE bench_trial_artifacts ADD CONSTRAINT bench_trial_artifacts_state_check
    CHECK (state IN ('populated', 'empty', 'error', 'loading', 'result'));
END $$;

-- The App bench studio (services/bench/studio.js): first versions built from
-- a brief the way the create-app flow builds them, driven from an admin's
-- connector session, with CONTEXT PACKS to vary what the bot is told and
-- REFERENCE builds (a Claude Code session's own app from the same inputs) to
-- compare it with.
--
-- A context pack is guidance text for the bot's first-version prompts and
-- files for the new app's first commit (a theme as a skill file, say). Each
-- save is a new version of its name; a version that a run has used is never
-- changed (`used_at`), so a result always names exactly what the bot read.
-- Private: it is admin-written material for a benchmark.
CREATE TABLE IF NOT EXISTS bench_context_packs (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  parent_id       INTEGER REFERENCES bench_context_packs(id) ON DELETE SET NULL,
  guidance        TEXT NOT NULL DEFAULT '',
  stage_guidance  JSONB NOT NULL DEFAULT '{}',
  files           JSONB NOT NULL DEFAULT '[]',
  notes           TEXT,
  sha256          VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at         TIMESTAMPTZ,
  UNIQUE (name, version)
);
COMMENT ON TABLE bench_context_packs IS 'staging:private';

-- A run is `suite` (the launcher's: every task of a suite at its stages) or
-- `studio` (the studio's: some briefs, on some models, with some packs).
-- `context_pack_ids` are the packs its arms were given; 0 stands for none.
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'suite';
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS context_pack_ids INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS references_per_brief INTEGER NOT NULL DEFAULT 0;

-- A trial's pack (none for every trial before the studio), its reference
-- label when it is a reference build handed in from outside (its `model` is
-- then `reference:<label>`), the commit a reference is captured at, what it
-- is doing right now (its step, its last few activity lines and the skills
-- it invoked, for the studio's watch), and when an admin kept its branch
-- past the sweep.
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS context_pack_id INTEGER REFERENCES bench_context_packs(id) ON DELETE SET NULL;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS reference_label TEXT;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS capture_sha TEXT;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS kept_at TIMESTAMPTZ;
-- One trial per task, model, PACK and attempt: the same model with and
-- without a pack are two arms of one run.
ALTER TABLE bench_trials DROP CONSTRAINT IF EXISTS bench_trials_run_id_task_id_model_attempt_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_trials_arm_attempt
  ON bench_trials(run_id, task_id, model, COALESCE(context_pack_id, 0), attempt);
-- `awaiting`: a reference build's trial while its branch is copied in; the
-- lane never claims it. Widening a CHECK never rejects a row already stored.
DO $$
BEGIN
  ALTER TABLE bench_trials DROP CONSTRAINT IF EXISTS bench_trials_status_check;
  ALTER TABLE bench_trials ADD CONSTRAINT bench_trials_status_check
    CHECK (status IN ('pending', 'running', 'ok', 'model_fail', 'infra_fail', 'timeout',
                      'not_applicable', 'skipped_cap', 'cancelled', 'awaiting'));
END $$;
-- A first version a restart interrupts goes on from where it was, as the
-- bot's own builds do (services/bench/lane.js "After a restart"):
-- `checkpoint` keeps what each finished sub-step left (the triage's answer,
-- the spec, the build's commit), the sessions it opened and which of them a
-- release already charged to the run. `prior_ms` is the time its earlier
-- claims ran and `first_started_at` its first claim, so its elapsed time
-- survives the restart.
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS prior_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS first_started_at TIMESTAMPTZ;

-- The first commit a brief's builds start from, made once per run, task and
-- pack: today's starter rendered for the app's name, its sketch card, and the
-- pack's files, as a commit with no history on `bench/r<run>-s<id>`. Every
-- arm of the run and every reference built for it start from this same
-- commit, so they are given exactly the same tree. `making` is claimed by
-- one trial; the others wait for `ready`.
CREATE TABLE IF NOT EXISTS bench_scaffolds (
  id                SERIAL PRIMARY KEY,
  run_id            INTEGER NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
  task_id           INTEGER NOT NULL REFERENCES bench_tasks(id) ON DELETE CASCADE,
  context_pack_id   INTEGER REFERENCES bench_context_packs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'making',
  sha               TEXT,
  branch            TEXT,
  sketch            JSONB,
  error             TEXT,
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at          TIMESTAMPTZ,
  branch_deleted_at TIMESTAMPTZ,
  CONSTRAINT bench_scaffolds_status_check CHECK (status IN ('making', 'ready', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_scaffolds_arm
  ON bench_scaffolds(run_id, task_id, COALESCE(context_pack_id, 0));
-- Whose claim a row in 'making' is (bench/scaffold.js ensure): a durable
-- trial carried on after a crash takes its own claim over at once.
ALTER TABLE bench_scaffolds ADD COLUMN IF NOT EXISTS claimed_by TEXT;
COMMENT ON TABLE bench_scaffolds IS 'staging:private';

-- A studio run's shared plans (services/bench/shared-plans.js): with
-- `shared_plans` on the run, each brief's plan is made once per pack and
-- repeat (`plan_key`, the attempt a trial was launched as; a rerun keeps
-- its trial's) and every arm builds from it: the plan from the description,
-- its early first look and the spec. `making` is claimed by one trial (its
-- maker); the others wait for `ready` and build from its spec.
ALTER TABLE bench_runs ADD COLUMN IF NOT EXISTS shared_plans BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS plan_key INTEGER;
CREATE TABLE IF NOT EXISTS bench_shared_plans (
  id                SERIAL PRIMARY KEY,
  run_id            INTEGER NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
  task_id           INTEGER NOT NULL REFERENCES bench_tasks(id) ON DELETE CASCADE,
  context_pack_id   INTEGER REFERENCES bench_context_packs(id) ON DELETE SET NULL,
  plan_key          INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'making',
  claimed_by        TEXT,
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maker_trial_id    INTEGER REFERENCES bench_trials(id) ON DELETE SET NULL,
  plan              JSONB,
  build_note        TEXT,
  early_look        TEXT,
  spec_md           TEXT,
  spec_html         TEXT,
  plan_usd          NUMERIC(12,6),
  look_usd          NUMERIC(12,6),
  error             TEXT,
  ready_at          TIMESTAMPTZ,
  CONSTRAINT bench_shared_plans_status_check CHECK (status IN ('making', 'ready', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_shared_plans_key
  ON bench_shared_plans(run_id, task_id, COALESCE(context_pack_id, 0), plan_key);
COMMENT ON TABLE bench_shared_plans IS 'staging:private';

-- The studio's one host app: a private project the benchmark user made
-- through the ordinary create path, whose repository carries every studio
-- branch and whose own database is empty, so a preview of a studio build
-- starts from a fresh database and never from anybody's data.
CREATE TABLE IF NOT EXISTS bench_studio_hosts (
  key         TEXT PRIMARY KEY,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE bench_studio_hosts IS 'staging:private';

-- A studio build put up as a preview for a day: the session the preview is
-- built on, and when it is taken down.
CREATE TABLE IF NOT EXISTS bench_previews (
  id            SERIAL PRIMARY KEY,
  trial_id      INTEGER NOT NULL REFERENCES bench_trials(id) ON DELETE CASCADE,
  session_id    INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'building',
  error         TEXT,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  CONSTRAINT bench_previews_status_check CHECK (status IN ('building', 'live', 'failed', 'ended'))
);
CREATE INDEX IF NOT EXISTS idx_bench_previews_open ON bench_previews(expires_at) WHERE status IN ('building', 'live');
COMMENT ON TABLE bench_previews IS 'staging:private';

-- #3624 stage 2: the bot's DM is read by a model (homeroom-bot-mayor.js).
-- One row per answer it wrote: what it cost (counted in the person's weekly
-- allowance with their requests' runs), how many model calls and which
-- tools it took, and why it failed when it did. Never the words: those are
-- the conversation's.
CREATE TABLE IF NOT EXISTS homeroom_bot_dm_turns (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id      INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  model           TEXT,
  rounds          INTEGER NOT NULL DEFAULT 0,
  tools           TEXT[] NOT NULL DEFAULT '{}',
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(12, 6),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_dm_turns_user
  ON homeroom_bot_dm_turns(user_id, created_at DESC);
COMMENT ON TABLE homeroom_bot_dm_turns IS 'staging:private';
-- #3733: how a turn went, still without the words. `failures` holds every
-- model request or step that failed on the way, recovered or not, as
-- "where:code[:HTTP status]" (r2:rate_limited:429, plain:timeout,
-- context:history:57P01); `fallback` what answered when the model could not
-- (posted, records, key, plain, broken). `error` stays why it could not.
ALTER TABLE homeroom_bot_dm_turns ADD COLUMN IF NOT EXISTS failures TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE homeroom_bot_dm_turns ADD COLUMN IF NOT EXISTS fallback TEXT;

-- #3624 stage 2: something the bot offered to do in a DM, done only when
-- the person taps to confirm: file a new request on a project (File it /
-- Not now), or (#11, WP3) withdraw one of its own proposals (Withdraw it /
-- Keep it; `session_id` is the proposal). The offer is a bot message with
-- the two answers under it; the tap decides it once.
CREATE TABLE IF NOT EXISTS homeroom_bot_dm_actions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'file_request',
  title           TEXT NOT NULL,
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  issue_number    INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_dm_actions_kind_check CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request')),
  CONSTRAINT homeroom_bot_dm_actions_status_check
    CHECK (status IN ('open', 'done', 'declined', 'failed'))
);
COMMENT ON TABLE homeroom_bot_dm_actions IS 'staging:private';
-- #11 (WP3): the proposal a withdrawal is about, and the wider kind check
-- for a database whose table predates it (CREATE TABLE IF NOT EXISTS above
-- skips an existing table, and its named CHECK allowed file_request only).
-- B3: `build_plan`, the plan card a first version waits on (B6), decided by
-- its buttons through the same action endpoint as an offer.
-- #4239: `move_request`, an offer to move a request about Homeroom itself
-- from a project's board to Homeroom's own (Move it to Homeroom / Keep it
-- here). `app_id` is the project it is on and `source_issue_number` the
-- request there; `issue_number` is the request it became on Homeroom's.
-- #4525: `close_request`, an offer to open a vote on closing request
-- `source_issue_number` of `app_id` (Propose to close / Keep it open).
ALTER TABLE homeroom_bot_dm_actions
  ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE homeroom_bot_dm_actions ADD COLUMN IF NOT EXISTS source_issue_number INTEGER;
DO $$
BEGIN
  ALTER TABLE homeroom_bot_dm_actions DROP CONSTRAINT IF EXISTS homeroom_bot_dm_actions_kind_check;
  ALTER TABLE homeroom_bot_dm_actions ADD CONSTRAINT homeroom_bot_dm_actions_kind_check
    CHECK (kind IN ('file_request', 'withdraw_proposal', 'build_plan', 'move_request', 'close_request'));
END $$;

-- The bot's own knobs, admin-tunable from its console section. `mode` is
-- `off` (the loop idles) or `shadow`, which the console calls On: it acts
-- for real on every app but the paused ones, for everyone with platform
-- access (`live` is still refused by the settings route). Ships `off` so the
-- change that adds the bot is itself inert.
INSERT INTO platform_settings (key, value) VALUES
  ('homeroom_bot_mode', 'off'),
  ('homeroom_bot_concurrency', '1'),
  ('homeroom_bot_batch_size', '10'),
  ('homeroom_bot_paused_apps', '[]'),
  ('homeroom_bot_shadow_builds', 'off'),
  ('homeroom_bot_build_concurrency', '2'),
  ('homeroom_bot_shadow_build_platform', 'off'),
  -- #3624: $50 a week for each person's requests.
  ('homeroom_bot_user_weekly_cents', '5000'),
  -- And $100 for an admin's, in place of it.
  ('homeroom_bot_admin_weekly_cents', '10000'),
  -- Live work 12 at once, 3 per person; a DM is read.
  ('homeroom_bot_live_at_once', '12'),
  ('homeroom_bot_per_person', '3'),
  ('homeroom_bot_dm_chat', 'on')
ON CONFLICT (key) DO NOTHING;
-- Live work went from 6 at once, 2 per person, to 12 and 3 when every
-- project went live. A database still on the old seed (no admin ever saved
-- these: updated_by is unset) moves up once; an admin's own number stays,
-- and so does the next one an admin saves, 6 or not.
UPDATE platform_settings SET value = '12', updated_at = NOW()
 WHERE key = 'homeroom_bot_live_at_once' AND value = '6' AND updated_by IS NULL;
UPDATE platform_settings SET value = '3', updated_at = NOW()
 WHERE key = 'homeroom_bot_per_person' AND value = '2' AND updated_by IS NULL;
-- The bot works for everyone and acts for real on every project but a
-- paused one. It was given out one person at a time first (a DM list, a
-- list of live apps, an admin's switch to everyone, and whether that took in
-- the platform's own project); those rows are retired. The moment it went
-- on for everyone is written once, on the first boot of the build that made
-- it so (homeroom-bot.js KEY_EVERYONE_SINCE): an older request nobody has
-- touched since is not picked up on its own. A moment the admin's switch
-- already wrote stands.
DELETE FROM platform_settings
 WHERE key IN ('homeroom_bot_live_apps', 'homeroom_bot_dm_users', 'homeroom_bot_audience', 'homeroom_bot_live_platform');
INSERT INTO platform_settings (key, value)
VALUES ('homeroom_bot_audience_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- #2721. Private, durable moderation records; target IDs intentionally have
-- no cascading FK: removing a target must not remove evidence or the audit.
ALTER TABLE notifications ALTER COLUMN detail TYPE VARCHAR(1200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS participation_restricted_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS moderation_suspended_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS moderation_hidden_at TIMESTAMPTZ;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS moderation_hidden_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS moderation_cases (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(32) NOT NULL CHECK (target_type IN ('app','user','app_message','conversation_message')),
  target_id BIGINT NOT NULL,
  target_label TEXT NOT NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','resolved','dismissed')),
  cycle INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE(target_type, target_id)
);
CREATE INDEX IF NOT EXISTS moderation_cases_queue ON moderation_cases(status, updated_at, id);
CREATE TABLE IF NOT EXISTS moderation_reports (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  cycle INTEGER NOT NULL,
  reporter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason VARCHAR(32) NOT NULL,
  detail VARCHAR(1000),
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  legacy_type VARCHAR(32), legacy_id BIGINT,
  UNIQUE(legacy_type, legacy_id)
);
CREATE TABLE IF NOT EXISTS moderation_evidence_files (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(32) NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  UNIQUE(source_type, source_id)
);
CREATE TABLE IF NOT EXISTS moderation_report_files (
  report_id BIGINT NOT NULL REFERENCES moderation_reports(id) ON DELETE CASCADE,
  file_id BIGINT NOT NULL REFERENCES moderation_evidence_files(id) ON DELETE CASCADE,
  PRIMARY KEY(report_id, file_id)
);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(32) NOT NULL,
  reason VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS moderation_message_originals (
  target_type VARCHAR(32) NOT NULL,
  target_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  PRIMARY KEY(target_type, target_id)
);
COMMENT ON TABLE moderation_cases IS 'staging:private';
COMMENT ON TABLE moderation_reports IS 'staging:private';
COMMENT ON TABLE moderation_evidence_files IS 'staging:private';
COMMENT ON TABLE moderation_report_files IS 'staging:private';
COMMENT ON TABLE moderation_actions IS 'staging:private';
COMMENT ON TABLE moderation_message_originals IS 'staging:private';

CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_unique_open ON moderation_reports(case_id,cycle,reporter_user_id) WHERE legacy_type IS NULL;

-- Retired: cross-Pod ownership of a preview build under the old preview
-- lifecycle (the preview machine owns every build since #5212).
DROP TABLE IF EXISTS preview_operations;


-- #2716 account deletion: the receipt carries only opaque record ids, never
-- an erased username, email, IP, password, or credential. It intentionally
-- outlives users so retries and restore reconciliation cannot revive access.
CREATE TABLE IF NOT EXISTS account_deletions (
  id VARCHAR(32) PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mode VARCHAR(8) NOT NULL CHECK (mode IN ('self', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
-- Account deletion anonymises the users row in place instead of deleting it,
-- so contributions keep a (nameless) author. A non-NULL value marks an
-- erased account: nothing may sign in as it or treat it as a live user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS account_deletion_tasks (
  id BIGSERIAL PRIMARY KEY,
  deletion_id VARCHAR(32) NOT NULL REFERENCES account_deletions(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('openrouter_key', 'worker', 'object', 'key_reconciliation')),
  target TEXT NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code VARCHAR(64),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (deletion_id, kind, target)
);
CREATE INDEX IF NOT EXISTS account_deletion_tasks_due
  ON account_deletion_tasks (next_attempt_at) WHERE state IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS account_deletion_tasks_worker
  ON account_deletion_tasks (target) WHERE kind = 'worker';
COMMENT ON TABLE account_deletions IS 'staging:private';
COMMENT ON TABLE account_deletion_tasks IS 'staging:private';

-- Preserve necessary historical totals and published attachments. The service
-- withdraws votes on open decisions BEFORE deleting the identity; completed
-- decisions keep their anonymous ballots and accounting keeps its amounts.
DO $$
DECLARE
  item RECORD;
  fk RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('pr_votes', 'user_id'), ('issue_votes', 'user_id'),
    ('pr_undo_votes', 'user_id'), ('llm_usage', 'user_id'),
    ('app_llm_usage', 'user_id'),
    ('global_chat_usage', 'user_id'), ('token_allocation', 'user_id'),
    ('agent_turns', 'user_id'), ('pr_kudos', 'giver_user_id'),
    ('issue_screenshots', 'user_id'), ('issue_videos', 'user_id')
  ) AS retained(table_name, column_name)
  LOOP
    FOR fk IN
      SELECT c.conname FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = to_regclass(item.table_name)
        AND c.confrelid = 'users'::regclass AND c.contype = 'f'
        AND a.attname = item.column_name AND c.confdeltype <> 'n'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.table_name, fk.conname);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', item.table_name, item.column_name);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE SET NULL',
        item.table_name, fk.conname, item.column_name);
    END LOOP;
  END LOOP;
END $$;

-- Only deletion-archived direct conversations get this exception. Ordinary
-- archived/blocked/declined conversations retain their existing access rules.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_peer BOOLEAN NOT NULL DEFAULT FALSE;

-- Old @mentions and manifest-admin declarations must never be inherited by
-- someone registering an erased account's handle. Keep only a fingerprint,
-- with no account id, original spelling, timestamp, or redirect target.
CREATE TABLE IF NOT EXISTS deleted_username_reservations (
  fingerprint TEXT PRIMARY KEY
);
COMMENT ON TABLE deleted_username_reservations IS 'staging:private';
CREATE OR REPLACE FUNCTION reject_deleted_username() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND LOWER(NEW.username) = LOWER(OLD.username) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('deleted-username:' || LOWER(NEW.username), 0));
  IF EXISTS (SELECT 1 FROM deleted_username_reservations
    WHERE fingerprint = encode(sha256(convert_to(LOWER(NEW.username), 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'username is unavailable' USING ERRCODE = '23505', CONSTRAINT = 'deleted_username_reserved';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_deleted_username_guard ON users;
CREATE TRIGGER users_deleted_username_guard BEFORE INSERT OR UPDATE OF username ON users
  FOR EACH ROW EXECUTE FUNCTION reject_deleted_username();

-- ═══════════════════════════════════════════════════════════════════════
-- Agent sessions (#2779, spec: docs/agent-sessions.md)
-- ═══════════════════════════════════════════════════════════════════════
--
-- An agent session is one long-lived conversation between a user and the
-- Mayor, not bound to an app, that never closes on its own. Its changes stay
-- ordinary chat_sessions rows (one app, one branch, one PR, one vote), linked
-- back through chat_sessions.agent_session_id, so every downstream system —
-- staging, checks, before & after shots, votes, merge, the sweepers — is untouched.
--
-- The retired experimental per-user flag. Agent sessions are on for
-- everyone and nothing reads this column any more; it stays so a rolling
-- deploy's older pods, which still SELECT it, keep working. Safe to drop in
-- a later migration once no such pod can be running.
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_sessions_enabled BOOLEAN;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              VARCHAR(256),
  -- 'auto' until the user renames it; a titler never overwrites 'manual'.
  title_source       VARCHAR(16) NOT NULL DEFAULT 'auto',
  -- 'open' or 'archived'. Nothing closes a session but its owner.
  status             VARCHAR(16) NOT NULL DEFAULT 'open',
  -- The app hint: a soft default for which app the user means, from the
  -- entry point or the Mayor. It never restricts what the session can do.
  focus_app_id       INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  -- {entry, issueNumber?, proposalId?} as the entry point sent it.
  focus_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The one change the Mayor is working on (D4). Scout and build dispatches
  -- go to it only; starting or switching to another change parks it.
  active_change_id   INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  -- The Mayor's model, split from the coding agent's (which each change
  -- carries itself, copied from here when the change starts). Unused: the
  -- conversation's one choice below drives both.
  mayor_model        VARCHAR(100),
  -- The conversation's coding-agent choice, from the composer's picker:
  -- 'claude_code' with an Anthropic model id, or 'codex_openrouter' with an
  -- OpenRouter model id (and agent_reasoning_effort, added below). NULL
  -- follows the user's default. The Mayor answers with it, a change the
  -- conversation starts is created with it, and the active change takes it
  -- at its next build.
  agent_backend      VARCHAR(32),
  agent_model        VARCHAR(100),
  -- Rolling compaction of older turns, and the last message id it covers.
  summary_md         TEXT,
  summary_through_id INTEGER,
  -- Lease for the conversation-level Mayor turn: one turn at a time.
  active_turn        JSONB,
  last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at        TIMESTAMPTZ,
  CONSTRAINT agent_sessions_status_check CHECK (status IN ('open', 'archived')),
  CONSTRAINT agent_sessions_title_source_check CHECK (title_source IN ('auto', 'manual')),
  CONSTRAINT agent_sessions_focus_context_check CHECK (jsonb_typeof(focus_context) = 'object'),
  CONSTRAINT agent_sessions_archived_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS agent_reasoning_effort VARCHAR(16);
-- What the lists' status marks read (#2779 follow-up). last_done_at is when a
-- turn that ran last finished (its lease released at the end); seen_at is
-- when the owner last read the conversation. Finished after it was last seen,
-- and not working now, is the green dot beside it in Recents, the mark's menu
-- and Messages; a held lease is the spinner.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS last_done_at TIMESTAMPTZ;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS agent_sessions_user_activity
  ON agent_sessions (user_id, last_activity_at DESC);
COMMENT ON TABLE agent_sessions IS 'staging:private';

-- A change started from an agent session. It has no chat of its own: POST
-- /api/sessions/:id/chat refuses it and points to the parent. Classic
-- sessions keep NULL forever.
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS agent_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_sessions_agent_session
  ON chat_sessions (agent_session_id) WHERE agent_session_id IS NOT NULL;

-- One transcript table holds both views: the conversation is
-- `WHERE agent_session_id = X` (rows with no active change carry a NULL
-- session_id), and one change's slice is `WHERE session_id = C`, as today.
-- SET NULL rather than CASCADE: a change's own rows outlive its parent. The
-- conversation-only rows (session_id NULL) are removed with their owner by
-- services/account-deletion.js.
ALTER TABLE chat_session_messages
  ADD COLUMN IF NOT EXISTS agent_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_session_messages_agent_session
  ON chat_session_messages (agent_session_id, id) WHERE agent_session_id IS NOT NULL;

-- Stamp the parent onto every row a change writes. There are dozens of
-- insert sites (scout publication, recovered wrap-ups, issue drafts, handoff
-- events, …); the trigger means none of them has to change and none can drop
-- a row out of the conversation. The WHEN clause keeps it to rows that name a
-- change and did not already say which conversation they belong to.
CREATE OR REPLACE FUNCTION stamp_chat_message_agent_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT cs.agent_session_id INTO NEW.agent_session_id
    FROM chat_sessions cs
   WHERE cs.id = NEW.session_id;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'chat_session_messages_stamp_agent_session'
       AND tgrelid = 'chat_session_messages'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER chat_session_messages_stamp_agent_session
      BEFORE INSERT ON chat_session_messages
      FOR EACH ROW WHEN (NEW.agent_session_id IS NULL AND NEW.session_id IS NOT NULL)
      EXECUTE FUNCTION stamp_chat_message_agent_session();
  END IF;
END $$;

-- The foreign key #2779 step 2 left for this table: a Mayor's delegated grant
-- names the agent session it serves, and goes with it.
--
-- NOT VALID, deliberately: it binds every row written from now on without
-- checking the rows already there. A grant written before this table existed
-- can name a session id that never did, and a validating ADD would fail the
-- whole schema apply — at boot. Such a grant is already dead: its liveness
-- join finds no open session of its user and refuses it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_delegations_agent_session_fk'
  ) THEN
    ALTER TABLE mcp_delegations
      ADD CONSTRAINT mcp_delegations_agent_session_fk
      FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

-- The Mayor's confirmation cards (#2779 step 3b). A write the Mayor proposes
-- — starting, promoting, syncing or withdrawing a change, filing or claiming
-- a request — never runs from the model. It is stored here, sealed, and runs
-- only when the owner presses Confirm on the card: once, before it expires,
-- with the exact input the card showed. The sealing is the shared core in
-- services/confirmations: an AES-GCM copy of the normalized input and its
-- fingerprint, so a stored row cannot be edited into a different action.
CREATE TABLE IF NOT EXISTS agent_session_actions (
  id                UUID PRIMARY KEY,
  agent_session_id  INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name         VARCHAR(64) NOT NULL,
  sealed_input      JSONB NOT NULL,
  input_hash        VARCHAR(64) NOT NULL,
  -- pending → running → done | failed, or pending → dismissed. Expiry is
  -- read from expires_at rather than written, so nothing has to sweep it.
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- What the tool answered, bounded, for the card and the conversation.
  result            JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ,
  CONSTRAINT agent_session_actions_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'dismissed')),
  CONSTRAINT agent_session_actions_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_session_actions_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS agent_session_actions_session
  ON agent_session_actions (agent_session_id, created_at DESC);
COMMENT ON TABLE agent_session_actions IS 'staging:private';

-- An agent session's saved drafts (#2779 follow-up, the dev chat's #798/#940
-- carried over): while the Mayor works, what the owner types next can be
-- parked here instead of held in their head, and sent — always by a tap,
-- never on its own — once the turn is over. Per ACCOUNT, like the dev chat's
-- list, so a second device shows the same drafts. The same shape and caps
-- as chat_session_drafts (routes/chat-drafts.js): client-generated ids, 20
-- per conversation, 10,000 characters each.
--
-- Retention follows the conversation (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS agent_session_drafts (
  agent_session_id INTEGER     NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  -- Always the conversation's owner, stored so a per-user query is one
  -- predicate on this table.
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id         VARCHAR(32) NOT NULL,
  content          TEXT        NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  saved_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_session_id, draft_id)
);
CREATE INDEX IF NOT EXISTS agent_session_drafts_session
  ON agent_session_drafts (agent_session_id, saved_at, draft_id);
CREATE INDEX IF NOT EXISTS agent_session_drafts_user
  ON agent_session_drafts (user_id);
-- Private like its conversation: unsent words, and a foreign key to the
-- private agent_sessions.
COMMENT ON TABLE agent_session_drafts IS 'staging:private';

-- Files attached to an agent-session message (#2779 follow-up): the dev
-- chat's own table, so the validation, the caps, the 24h orphan sweep, the
-- account-deletion purge and the coding agent's download path
-- (routes/internal.js) all apply unchanged. A conversation's message need
-- not have a change, so such a row names the conversation instead of a
-- session: agent_session_id set, session_id NULL. Every row names one or the
-- other. The table stays staging:private (above).
ALTER TABLE chat_session_attachments
  ADD COLUMN IF NOT EXISTS agent_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE CASCADE;
ALTER TABLE chat_session_attachments ALTER COLUMN session_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_session_attachments_owner_chk'
  ) THEN
    ALTER TABLE chat_session_attachments
      ADD CONSTRAINT chat_session_attachments_owner_chk
      CHECK (session_id IS NOT NULL OR agent_session_id IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_agent_session
  ON chat_session_attachments(agent_session_id) WHERE agent_session_id IS NOT NULL;

-- ── Keeping every screen of a conversation in step with the server ──────
--
-- A conversation's screens (its own screen, the Messages pane, the side
-- panel, another device) used to learn what changed from one in-memory event
-- stream that had to reach each of them exactly once. Now the database says
-- when a conversation changed, whatever changed it:
--
--   state_version  one counter per conversation, bumped by the triggers
--                  below on every write a screen draws: a message written or
--                  edited, its active change's status, checks or preview, the
--                  Mayor's turn starting, moving phase or ending, a card, the
--                  title, the model, the archive.
--   rev            a stamp on every message row, from one sequence, taken on
--                  insert AND on update, so a screen asks for "what changed
--                  since rev N" and gets the edited rows (a card's outcome, a
--                  cost) as well as the new ones.
--
-- Each bump is announced to the owner's open sockets on every pod: the
-- trigger speaks services/ws-bus.js's own envelope on its own channel
-- (`usernode_ws`, kind `user`), with an instance id no process has, so every
-- instance delivers it once, the writer's included. A screen that hears a
-- version it does not have re-reads GET /api/agent-sessions/:id/state.
-- tests/agent-session-sync.test.js pins the envelope to ws-bus.js.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 0;

CREATE SEQUENCE IF NOT EXISTS chat_session_messages_rev_seq;
ALTER TABLE chat_session_messages ADD COLUMN IF NOT EXISTS rev BIGINT;

-- A message sent from a conversation carries the client's id for it, so a
-- send retried after a dropped connection is recognised instead of written
-- twice. The dev chat's index above is per change, and a conversation's
-- message may have no change (session_id NULL), so this one is per
-- conversation.
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_messages_agent_client_message_idx
  ON chat_session_messages (agent_session_id, client_message_id)
  WHERE agent_session_id IS NOT NULL AND client_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION stamp_chat_message_rev() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.rev := nextval('chat_session_messages_rev_seq');
  RETURN NEW;
END;
$$;

-- Per statement: one bump per conversation a statement touched, however
-- many of its rows it wrote.
CREATE OR REPLACE FUNCTION bump_agent_session_version_from_messages() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_sessions s
     SET state_version = s.state_version + 1
   WHERE s.id IN (SELECT DISTINCT r.agent_session_id FROM changed_rows r
                   WHERE r.agent_session_id IS NOT NULL);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_agent_session_version_from_actions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_sessions s
     SET state_version = s.state_version + 1
   WHERE s.id IN (SELECT DISTINCT r.agent_session_id FROM changed_rows r);
  RETURN NULL;
END;
$$;

-- A change's own row moves on its own (checks, the preview, the vote): the
-- conversation it belongs to is bumped when something its screens draw
-- moved. The WHEN clause on the trigger keeps every other update of
-- chat_sessions (heartbeats, worker bookkeeping) away from it.
CREATE OR REPLACE FUNCTION bump_agent_session_version_from_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_sessions SET state_version = state_version + 1
   WHERE id IN (NEW.agent_session_id, OLD.agent_session_id);
  RETURN NULL;
END;
$$;

-- The conversation's own row. Only what a screen draws bumps it: renewing
-- the turn lease every half minute, reading the conversation (seen_at) and
-- the compaction summary do not. A write that already moved state_version
-- (the triggers above) is left as it is.
CREATE OR REPLACE FUNCTION agent_session_state_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state_version = OLD.state_version AND (
       NEW.title IS DISTINCT FROM OLD.title
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.focus_app_id IS DISTINCT FROM OLD.focus_app_id
    OR NEW.focus_context IS DISTINCT FROM OLD.focus_context
    OR NEW.active_change_id IS DISTINCT FROM OLD.active_change_id
    OR NEW.agent_backend IS DISTINCT FROM OLD.agent_backend
    OR NEW.agent_model IS DISTINCT FROM OLD.agent_model
    OR NEW.agent_reasoning_effort IS DISTINCT FROM OLD.agent_reasoning_effort
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
    OR NEW.last_done_at IS DISTINCT FROM OLD.last_done_at
    OR (NEW.active_turn->>'id') IS DISTINCT FROM (OLD.active_turn->>'id')
    OR (NEW.active_turn->>'phase') IS DISTINCT FROM (OLD.active_turn->>'phase')
    OR (NEW.active_turn->>'stopRequestedAt') IS DISTINCT FROM (OLD.active_turn->>'stopRequestedAt')
  ) THEN
    NEW.state_version := OLD.state_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- `busy` is a hint for the lists' spinner; the screen re-reads for the
-- truth. 90 seconds is services/agent-sessions.js TURN_LEASE_STALE_SECONDS.
CREATE OR REPLACE FUNCTION agent_session_state_announce() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('usernode_ws', json_build_object(
    'i', 'db:agent_sessions',
    'k', 'user',
    'r', json_build_object('userId', NEW.user_id),
    'd', json_build_object(
      'type', 'agent_session_changed',
      'agentSessionId', NEW.id,
      'version', NEW.state_version,
      'busy', (NEW.active_turn IS NOT NULL
               AND COALESCE(NEW.active_turn->>'renewedAt', NEW.active_turn->>'startedAt')::timestamptz
                   >= NOW() - interval '90 seconds')
    )
  )::text);
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_session_messages_zz_stamp_rev'
                   AND tgrelid = 'chat_session_messages'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_session_messages_zz_stamp_rev
      BEFORE INSERT OR UPDATE ON chat_session_messages
      FOR EACH ROW EXECUTE FUNCTION stamp_chat_message_rev();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_session_messages_agent_version_ins'
                   AND tgrelid = 'chat_session_messages'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_session_messages_agent_version_ins
      AFTER INSERT ON chat_session_messages
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_session_version_from_messages();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_session_messages_agent_version_upd'
                   AND tgrelid = 'chat_session_messages'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_session_messages_agent_version_upd
      AFTER UPDATE ON chat_session_messages
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_session_version_from_messages();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_session_messages_agent_version_del'
                   AND tgrelid = 'chat_session_messages'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_session_messages_agent_version_del
      AFTER DELETE ON chat_session_messages
      REFERENCING OLD TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_session_version_from_messages();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_session_actions_version_ins'
                   AND tgrelid = 'agent_session_actions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER agent_session_actions_version_ins
      AFTER INSERT ON agent_session_actions
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_session_version_from_actions();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_session_actions_version_upd'
                   AND tgrelid = 'agent_session_actions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER agent_session_actions_version_upd
      AFTER UPDATE ON agent_session_actions
      REFERENCING NEW TABLE AS changed_rows
      FOR EACH STATEMENT EXECUTE FUNCTION bump_agent_session_version_from_actions();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_sessions_agent_session_version'
                   AND tgrelid = 'chat_sessions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_sessions_agent_session_version
      AFTER UPDATE ON chat_sessions
      FOR EACH ROW WHEN (
        (NEW.agent_session_id IS NOT NULL OR OLD.agent_session_id IS NOT NULL) AND (
             NEW.agent_session_id IS DISTINCT FROM OLD.agent_session_id
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
          OR NEW.pr_title IS DISTINCT FROM OLD.pr_title
          OR NEW.session_title IS DISTINCT FROM OLD.session_title
          OR NEW.staging_url IS DISTINCT FROM OLD.staging_url
          OR NEW.check_state IS DISTINCT FROM OLD.check_state
          OR NEW.check_error_detail IS DISTINCT FROM OLD.check_error_detail
          OR NEW.test_results IS DISTINCT FROM OLD.test_results
          OR NEW.shots_state IS DISTINCT FROM OLD.shots_state
          OR NEW.shots_run_id IS DISTINCT FROM OLD.shots_run_id))
      EXECUTE FUNCTION bump_agent_session_version_from_change();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_sessions_state_touch'
                   AND tgrelid = 'agent_sessions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER agent_sessions_state_touch
      BEFORE UPDATE ON agent_sessions
      FOR EACH ROW EXECUTE FUNCTION agent_session_state_touch();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_sessions_state_announce'
                   AND tgrelid = 'agent_sessions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER agent_sessions_state_announce
      AFTER UPDATE ON agent_sessions
      FOR EACH ROW WHEN (NEW.state_version IS DISTINCT FROM OLD.state_version)
      EXECUTE FUNCTION agent_session_state_announce();
  END IF;
END $$;

-- Admin Support (#admin/support): one row per thing staff did to or looked
-- at on a participant's account. `view` rows are the access audit (one per
-- admin, user and hour); `points_adjustment` / `points_reversal` rows carry
-- the reason and inputs behind the user_activities row they created (its id
-- lands in payload.activity_id). Private: reasons and ticket references
-- describe individual users' support cases.
CREATE TABLE IF NOT EXISTS support_actions (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          VARCHAR(32) NOT NULL,
  reason          TEXT,
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_actions_target_created
  ON support_actions (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_actions_actor_target_created
  ON support_actions (actor_user_id, target_user_id, created_at);
COMMENT ON TABLE support_actions IS 'staging:private';
-- A support adjustment can be reversed once: the reversal row names the
-- activity it cancels in metadata.reverses.
CREATE UNIQUE INDEX IF NOT EXISTS user_activities_support_reversal_unique
  ON user_activities ((metadata->>'reverses'))
  WHERE source = 'support_adjustment' AND metadata ? 'reverses';

-- Admin "Deduplicate user" (#admin/users/<id>, src/services/user-merge.js):
-- one row per merge of two accounts that belonged to the same person. The
-- kept account received every row that referenced the merged one; the
-- merged row was anonymised in place so historical ids stay valid. `moved`,
-- `dropped` and `retained` are per-table row counts ("table.column": n):
-- rows re-pointed at the kept account, the merged account's rows removed
-- because the kept account already had the same record (kept wins), and
-- conflicting rows left on the anonymised account because removing them
-- would destroy something (a wallet, a live key, a proposal). No email or
-- username is stored here. Private: it links two identities of one person.
--
-- merged_user_id is unique: an account is merged away at most once, and
-- the index is what makes a double submit fail instead of merging twice.
-- The user columns are SET NULL on delete so a later account deletion
-- keeps the audit row.
CREATE TABLE IF NOT EXISTS user_merges (
  id               BIGSERIAL PRIMARY KEY,
  kept_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  merged_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email_kept_from  VARCHAR(8) NOT NULL CHECK (email_kept_from IN ('kept', 'merged')),
  moved            JSONB NOT NULL DEFAULT '{}',
  dropped          JSONB NOT NULL DEFAULT '{}',
  retained         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_merges_merged_unique ON user_merges (merged_user_id);
CREATE INDEX IF NOT EXISTS idx_user_merges_kept ON user_merges (kept_user_id, created_at DESC);
COMMENT ON TABLE user_merges IS 'staging:private';

-- ── Communities: who a project belongs to ───────────────────────────────
--
-- Every project (today: every row in `apps`) belongs to exactly one
-- community, and a community is the unit people join. It is the internal
-- name only: on screen a community is labelled by its AUDIENCE — "Just
-- you", "Group" or "Community" — and what it owns are "projects". See
-- AGENTS.md, "Communities own projects".
--
-- STAGE 0 KEEPS THEM ONE-TO-ONE. Each app gets its own community (the
-- trigger below mints one on insert, the loop under it backfills existing
-- apps), and nothing yet puts a second app into one. That is why this
-- table is almost bare: the name and the audience still live on the app
-- while there is only one app to read them from, and move here the day a
-- community can own more than one project.
--
--   audience is DERIVED, never stored (src/services/communities.js,
--   audienceSql): a view-public app is 'open' (Community); a private one
--   with anyone beyond its creator in it — a member or a pending invite —
--   is 'invited' (Group); anything else is 'solo' (Just you). Storing it
--   would give dapp.json's visibility reconcile a second column to keep in
--   step, and the first time it forgot, the label would lie.
--
-- Deliberately NOT staging:private, for the reason app_collaborators gives:
-- membership decides who may propose and vote, so a staging clone without
-- it would refuse every vote its own checks cast. No row carries a secret.
CREATE TABLE IF NOT EXISTS communities (
  id          SERIAL PRIMARY KEY,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS community_id INTEGER REFERENCES communities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_apps_community ON apps (community_id);

-- Who is in a community. Joining is what lets a person propose changes to
-- its projects and vote on them (src/services/communities.js,
-- requireMembership); reading, using and chatting stay on the app's own
-- view/collab visibility, which this table does not replace.
--
-- `source` records how the row arrived, for the admin console and for the
-- day someone asks "why am I in this": 'creator' and 'collaborator' mirror
-- app_collaborators, 'favorite' is a Your-apps pin, 'active' and 'voter'
-- are the one-time backfill below, 'auto' is the platform's own project
-- (every account with platform access is in it), and 'joined' is the Join
-- button.
CREATE TABLE IF NOT EXISTS community_members (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       VARCHAR(16) NOT NULL DEFAULT 'joined',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members (user_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'community_members_source_check' AND conrelid = 'community_members'::regclass
  ) THEN
    ALTER TABLE community_members ADD CONSTRAINT community_members_source_check
      CHECK (source IN ('creator', 'collaborator', 'favorite', 'active', 'voter', 'auto', 'joined'));
  END IF;
END $$;

-- Every app gets a community the moment it exists. AFTER INSERT rather than
-- BEFORE, and that is load-bearing: the platform's own row is written by an
-- `INSERT ... ON CONFLICT (slug) DO UPDATE` on every boot
-- (src/db/migrate.js), and a BEFORE trigger fires ahead of the conflict
-- check — it would mint an orphan community per boot. AFTER INSERT fires
-- only for a row that was really inserted.
--
-- The platform's own project also takes in every account that already has
-- platform access, which is what "everyone is in Homeroom's development"
-- means on a fresh database, where that row is seeded after the accounts.
CREATE OR REPLACE FUNCTION create_app_community() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cid INTEGER;
BEGIN
  INSERT INTO communities (created_by) VALUES (NEW.created_by) RETURNING id INTO cid;
  UPDATE apps SET community_id = cid WHERE id = NEW.id;
  IF NEW.self_hosted THEN
    INSERT INTO community_members (community_id, user_id, source)
      SELECT cid, u.id, 'auto' FROM users u WHERE u.has_platform_access
    ON CONFLICT (community_id, user_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'apps_create_community'
       AND tgrelid = 'apps'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER apps_create_community
      AFTER INSERT ON apps
      FOR EACH ROW WHEN (NEW.community_id IS NULL)
      EXECUTE FUNCTION create_app_community();
  END IF;
END $$;

-- A deleted app takes its community with it once nothing else points at it
-- (always, while communities and apps are one-to-one). The members go with
-- the community by cascade.
CREATE OR REPLACE FUNCTION drop_orphan_app_community() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.community_id IS NOT NULL THEN
    DELETE FROM communities c
     WHERE c.id = OLD.community_id
       AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.community_id = c.id);
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'apps_drop_orphan_community'
       AND tgrelid = 'apps'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER apps_drop_orphan_community
      AFTER DELETE ON apps
      FOR EACH ROW
      EXECUTE FUNCTION drop_orphan_app_community();
  END IF;
END $$;

-- Backfill: one community per existing app. Idempotent — only rows still
-- without one are touched, so later boots do nothing.
DO $$
DECLARE
  r RECORD;
  cid INTEGER;
BEGIN
  FOR r IN SELECT id, created_by FROM apps WHERE community_id IS NULL ORDER BY id LOOP
    INSERT INTO communities (created_by, created_at) VALUES (r.created_by, NOW()) RETURNING id INTO cid;
    UPDATE apps SET community_id = cid WHERE id = r.id;
  END LOOP;
END $$;

-- COLLABORATORS AND PINS ARE MEMBERS. Three triggers keep this table a
-- superset of the two older ones, whichever of the many paths wrote them
-- (create and fork, invite accept, the dapp.json admin reconcile, demo
-- mode, the staging seeds) — a trigger is the one place none of them can
-- forget.
--
--   app_collaborators 'member' row  → joins (and leaving the app's
--     collaborators leaves the community: removal is the owner's "remove
--     member", and Leave deletes both);
--   app_favorites pin (hidden=FALSE) → joins. Unpinning does NOT leave:
--     a pin is a shortcut on Home, and taking it off Home is not leaving;
--   users gaining platform access   → joins the platform's own project.
CREATE OR REPLACE FUNCTION sync_collaborator_community_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM community_members m
     USING apps a
     WHERE a.id = OLD.app_id
       AND m.community_id = a.community_id
       AND m.user_id = OLD.user_id;
    RETURN NULL;
  END IF;
  INSERT INTO community_members (community_id, user_id, source)
    SELECT a.community_id, NEW.user_id,
           CASE WHEN a.created_by = NEW.user_id THEN 'creator' ELSE 'collaborator' END
      FROM apps a
     WHERE a.id = NEW.app_id AND a.community_id IS NOT NULL
  ON CONFLICT (community_id, user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'app_collaborators_join_community'
       AND tgrelid = 'app_collaborators'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER app_collaborators_join_community
      AFTER INSERT OR UPDATE OF status ON app_collaborators
      FOR EACH ROW WHEN (NEW.status = 'member')
      EXECUTE FUNCTION sync_collaborator_community_member();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'app_collaborators_leave_community'
       AND tgrelid = 'app_collaborators'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER app_collaborators_leave_community
      AFTER DELETE ON app_collaborators
      FOR EACH ROW WHEN (OLD.status = 'member')
      EXECUTE FUNCTION sync_collaborator_community_member();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_favorite_community_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO community_members (community_id, user_id, source)
    SELECT a.community_id, NEW.user_id, 'favorite'
      FROM apps a
     WHERE a.id = NEW.app_id AND a.community_id IS NOT NULL
  ON CONFLICT (community_id, user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'app_favorites_join_community'
       AND tgrelid = 'app_favorites'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER app_favorites_join_community
      AFTER INSERT OR UPDATE OF hidden ON app_favorites
      FOR EACH ROW WHEN (NOT NEW.hidden)
      EXECUTE FUNCTION sync_favorite_community_member();
  END IF;
END $$;

-- Only on the false → true edge. A later write that sets the flag to TRUE
-- again (an admin re-grant, a repeated redemption) must not put back
-- someone who has since left.
CREATE OR REPLACE FUNCTION join_platform_community() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.has_platform_access THEN
    RETURN NULL;
  END IF;
  INSERT INTO community_members (community_id, user_id, source)
    SELECT a.community_id, NEW.id, 'auto'
      FROM apps a
     WHERE a.self_hosted AND a.community_id IS NOT NULL
  ON CONFLICT (community_id, user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_join_platform_community'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_join_platform_community
      AFTER INSERT OR UPDATE OF has_platform_access ON users
      FOR EACH ROW WHEN (NEW.has_platform_access)
      EXECUTE FUNCTION join_platform_community();
  END IF;
END $$;

-- One-time backfill: everyone who is already taking part is already a
-- member, so requiring membership to propose and vote locks nobody out.
-- Guarded by a marker row, like weekly_limit_backfilled: a re-runnable
-- insert would put back, on every boot, everyone who has since left.
--
--   - collaborators (creator included) and non-hidden pins;
--   - the active users each app's vote threshold counts today
--     (src/services/active-users.js: ever >= 60s on one day, and a visit in
--     the last 10 days; on a collab-private app only its collaborators,
--     who are already in by the line above);
--   - anyone who proposed a change or voted on one in the last 90 days —
--     the people whose vote the new rule would otherwise refuse first;
--   - on the platform's own project, every account with platform access,
--     because today every such account may vote there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'community_members_backfilled') THEN
    INSERT INTO community_members (community_id, user_id, source, joined_at)
      SELECT a.community_id, c.user_id,
             CASE WHEN a.created_by = c.user_id THEN 'creator' ELSE 'collaborator' END,
             COALESCE(c.accepted_at, c.created_at, NOW())
        FROM app_collaborators c JOIN apps a ON a.id = c.app_id
       WHERE c.status = 'member' AND a.community_id IS NOT NULL
    ON CONFLICT (community_id, user_id) DO NOTHING;

    INSERT INTO community_members (community_id, user_id, source, joined_at)
      SELECT a.community_id, f.user_id, 'favorite', f.created_at
        FROM app_favorites f JOIN apps a ON a.id = f.app_id
       WHERE NOT f.hidden AND a.community_id IS NOT NULL
    ON CONFLICT (community_id, user_id) DO NOTHING;

    INSERT INTO community_members (community_id, user_id, source)
      SELECT DISTINCT a.community_id, x.user_id, 'active'
        FROM app_activity x JOIN apps a ON a.id = x.app_id
       WHERE x.date >= CURRENT_DATE - 10
         AND a.community_id IS NOT NULL
         AND NOT a.self_hosted
         AND a.collab_visibility = 'public'
         AND EXISTS (
           SELECT 1 FROM app_activity q
            WHERE q.app_id = x.app_id AND q.user_id = x.user_id AND q.seconds_spent >= 60
         )
    ON CONFLICT (community_id, user_id) DO NOTHING;

    INSERT INTO community_members (community_id, user_id, source)
      SELECT DISTINCT a.community_id, p.user_id, 'voter'
        FROM (
          SELECT cs.app_id, v.user_id
            FROM pr_votes v JOIN chat_sessions cs ON cs.id = v.session_id
           WHERE v.created_at > NOW() - INTERVAL '90 days'
          UNION
          SELECT cs.app_id, cs.user_id
            FROM chat_sessions cs
           WHERE cs.promoted_at > NOW() - INTERVAL '90 days'
        ) p
        JOIN apps a ON a.id = p.app_id
       WHERE p.user_id IS NOT NULL
         AND a.community_id IS NOT NULL
         AND a.collab_visibility = 'public'
    ON CONFLICT (community_id, user_id) DO NOTHING;

    INSERT INTO community_members (community_id, user_id, source)
      SELECT a.community_id, u.id, 'auto'
        FROM apps a CROSS JOIN users u
       WHERE a.self_hosted AND a.community_id IS NOT NULL AND u.has_platform_access
    ON CONFLICT (community_id, user_id) DO NOTHING;

    INSERT INTO platform_settings (key, value)
      VALUES ('community_members_backfilled', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- ── Communities, stage 5: the first run ─────────────────────────────────
--
-- A new account picks the communities it wants to join (Homeroom first)
-- after its username and the terms (src/services/onboarding.js). Home then
-- showed it a "Getting started" card, the tour and the season's First
-- challenges, until #4635 retired the card: the First challenges are ordinary
-- cards in Home's Challenges area now. The card's columns below stay, unread
-- by Home: Admin › Journey reads them (src/services/journey.js), and this
-- file is replayed on every boot, where a DROP cannot be taken back.
--
-- users.needs_communities_choice — this account has not been asked yet.
-- Set TRUE by every path a person signs up through (email, an activation
-- code, a wallet).
-- A FLAG WRITTEN AT SIGN-UP, the shape needs_username_choice has, rather
-- than "communities_onboarded_at IS NULL": every account that existed
-- before this column reads FALSE by default, so nobody who already uses the
-- platform is walked through a screen for newcomers, and neither are the
-- accounts the boot seeds (capture identities, staging fixtures), which a
-- NULL-means-new rule would have put behind a blocking step on every
-- replay. No backfill, so nothing to guard with a marker row.
ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE;
-- When the join screen was answered.
ALTER TABLE users ADD COLUMN IF NOT EXISTS communities_onboarded_at TIMESTAMPTZ;
-- The retired card's close button (#4635: nothing writes it now).
ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_closed_at TIMESTAMPTZ;
-- Visits the card asks for that leave no row behind of their own. The old
-- card wrote { "workshop": "<iso>", "discover": "<iso>" } on any visit; since
-- its steps became the season's First challenges (2026-10-01) nothing reads
-- those two keys. One key is read: "vote_workshop", the last time the Vote
-- step's Workshop opened while NOTHING was up for a vote in any community
-- the account is in (the retired card's markWorkshopVisit; nothing writes it
-- since #4635), which the scorer's VOTE_CAST still counts like a vote. A new key rather than "workshop",
-- because those old visits were recorded whether or not a vote was waiting.
-- Reset first run clears the whole column. Kept rather than dropped: this
-- file is replayed on every boot, and a DROP is the one statement here that
-- cannot be taken back.
ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_seen JSONB;
-- When this account finished (or skipped) the welcome tour
-- (frontend/src/features/home/tour). Server state for the same reason as the
-- card's close: "done" used to live only in the browser's storage, so every
-- other device, a cleared or evicted storage, a private window and the move
-- to a new domain all offered the tour again. The browser's own flag still
-- counts, and a browser that has it copies it here once. Reset first run
-- clears it, so the tour follows the join screen again on every device.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_done_at TIMESTAMPTZ;
-- The Getting started list that WAS the First challenges (evan, 2026-10-01):
-- the card on Home was the tour plus the season's ONBOARDING challenges, and
-- until all of them were done the rest of the season was hidden. #4635
-- retired the card and the gate: every account sees the whole season, and
-- nothing reads these two to decide what is shown. Admin › Journey still
-- reads the flag to tell a newcomer from an older account. Both only for
-- accounts made after the list shipped.
--
-- getting_started_gate — this account starts on that list. Set TRUE at
-- sign-up by the same three INSERTs that set needs_communities_choice
-- (email, an activation code, a wallet), and by an admin's Reset first run.
-- A FLAG WRITTEN AT SIGN-UP, for the reasons needs_communities_choice is one
-- (above): every existing row reads FALSE by default with no backfill, and
-- so does every account the boot seeds (capture identities, staging
-- fixtures), which a "created after <date>" rule would have caught on every
-- fresh database, where every row is new. A cutoff kept as a platform
-- setting would also need writing once at deploy, and a staging clone would
-- carry production's value into a database whose seeded accounts are all
-- younger than it.
--
-- getting_started_unlocked_at — when this account's gate first opened (the
-- tour done and every First challenge done). Nothing writes it since #4635,
-- which retired the gate. Reset first run clears it with the rest.
ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_gate BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_unlocked_at TIMESTAMPTZ;

-- ── Communities, stage 6: invite links ──────────────────────────────────
--
-- A link anyone can open to join a community: /invite/<token>
-- (src/services/community-invites.js). Any member makes one; it lasts
-- `expires_at` and works for `max_uses` people (7 days and 25 unless the
-- maker says otherwise), and whoever made it, a project admin or a platform
-- admin can turn it off (`revoked_at`).
--
-- What a link GRANTS is what its maker could grant: on a project where
-- building is by invitation (collab-private) it is the collaborator invite,
-- accepted; anywhere else it is membership. One function below applies it,
-- so the two moments it happens (on the spot, and when a queued person is
-- let in) cannot disagree.
--
-- `app_id` is the project the link was made from. Communities and apps are
-- one-to-one today, so it names the community's one project; `community_id`
-- is kept beside it for the day a community owns several (#3292).
--
-- staging:private: a live token is a way in, which is auth material, and
-- the redemptions say who followed whose link.
CREATE TABLE IF NOT EXISTS community_invites (
  id           SERIAL PRIMARY KEY,
  token        VARCHAR(32) NOT NULL UNIQUE,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses     INTEGER NOT NULL DEFAULT 25 CHECK (max_uses BETWEEN 1 AND 100),
  uses         INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_invites_app ON community_invites (app_id, created_by);
COMMENT ON TABLE community_invites IS 'staging:private';
-- WP-D: a link may have no end date (expires_at NULL) and work for any number
-- of people (max_uses NULL): it works until it is turned off. The first
-- session's invite is made this way (services/community-invites.js NO_LIMIT).
ALTER TABLE community_invites ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE community_invites ALTER COLUMN max_uses DROP NOT NULL;

-- The maker's own words, shown on the page a link opens and in its preview
-- ("Come help with our run tracker!"). Plain text, at most 280 characters;
-- NULL when they left none. services/community-invites.js cleanNote() is the
-- one writer.
ALTER TABLE community_invites ADD COLUMN IF NOT EXISTS note TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'community_invites'::regclass
       AND conname = 'community_invites_note_length'
  ) THEN
    ALTER TABLE community_invites
      ADD CONSTRAINT community_invites_note_length
      CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280);
  END IF;
END $$;

-- One row per person who followed a link. 'joined' was applied; 'queued' is
-- somebody without platform access yet, whose community waits for the day
-- they are let in (the trigger below applies it then); 'cancelled' was
-- queued on a link that was turned off first. `skipped_waitlist` marks the
-- invite tree letting them in (users.admitted_by says by whom).
CREATE TABLE IF NOT EXISTS community_invite_redemptions (
  id               SERIAL PRIMARY KEY,
  invite_id        INTEGER NOT NULL REFERENCES community_invites(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           VARCHAR(16) NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('joined', 'queued', 'cancelled')),
  skipped_waitlist BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at       TIMESTAMPTZ,
  UNIQUE (invite_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_invite_redemptions_user
  ON community_invite_redemptions (user_id) WHERE applied_at IS NULL;
COMMENT ON TABLE community_invite_redemptions IS 'staging:private';

-- THE INVITE TREE (retired): who a link let past the waitlist, on one of its
-- maker's skips, while links could do that. Private membership replaced it
-- (`private_member_since` below), so nothing writes `admitted_by` now, and
-- the Admin → Waitlist switch it read is gone with its setting row (below).
-- The columns keep the history: Journey's door for those accounts.
-- `invite_generation` 0 is "let off the waitlist by us, by hand" (an admin
-- admitting a waitlist row, or granting an account directly): grantPlatform-
-- Access writes it only when that grant is what lets them in. 1 is somebody
-- a link let in (a generation-0 person's, or an admin's), and so on. NULL is
-- no place in the tree, and no skips: everyone who had access before this,
-- activation codes, genesis wallets. Skips used is a COUNT of admitted_by,
-- so there is no counter to drift.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_generation SMALLINT;
CREATE INDEX IF NOT EXISTS idx_users_admitted_by ON users (admitted_by) WHERE admitted_by IS NOT NULL;
-- A PRIVATE MEMBER: somebody without platform access whom an invite link
-- let into its community straight away, instead of queueing it for the day
-- they are let in. They use and change their communities' apps, but do not
-- make apps of their own; they are on the waitlist for that. The tier is
-- `has_platform_access = FALSE AND private_member_since IS NOT NULL`, so
-- letting them in (has_platform_access → TRUE, the waitlist's own release)
-- ends it with no second write, and the triggers on that edge (the
-- platform community, the welcome DM, queued invites) fire then, not here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_member_since TIMESTAMPTZ;
-- A PROVISIONAL HANDLE: an invite's phone sign-up gives a name, not a
-- username, and its handle is made from the name (usernames.handlesFromName)
-- for the private group that invited them to see. Nothing public may show it:
-- a public app's identity token, a public community's membership and a
-- public invite's join all refuse with username_required until the person
-- picks a username (POST /api/me/username/choose clears this), and the shell
-- asks for one first. Their name reaches a public place only as a username
-- they chose.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_provisional_since TIMESTAMPTZ;
-- The retired tree's on/off switch (services/community-invites.js used to read
-- it). Nothing reads it now; idempotent, so a boot after the first finds none.
DELETE FROM platform_settings WHERE key = 'invite_tree_enabled';

-- Whether the person who made a link can still grant what it grants: an
-- admin, or a collaborator where building is by invitation, or a member
-- elsewhere. A link dies with its maker's standing — somebody removed from
-- a group does not keep a way to add people to it — and a link whose maker
-- is gone dies too. services/community-invites.js reads this for the
-- preview and the redeem; apply_community_invite() below reads it again at
-- release, for a queued person.
CREATE OR REPLACE FUNCTION community_invite_maker_holds(p_invite INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM community_invites i
      JOIN apps a ON a.id = i.app_id
      JOIN users u ON u.id = i.created_by
     WHERE i.id = p_invite
       AND (u.is_admin
            OR CASE WHEN a.collab_visibility = 'private' AND NOT a.self_hosted
                    THEN EXISTS (SELECT 1 FROM app_collaborators c
                                  WHERE c.app_id = a.id AND c.user_id = u.id AND c.status = 'member')
                    ELSE EXISTS (SELECT 1 FROM community_members m
                                  WHERE m.community_id = a.community_id AND m.user_id = u.id)
               END)
  );
$$;

-- Apply one redemption: the grant, the membership and the Home pin, as the
-- Join button does (communities.join). Idempotent: an applied row is left
-- alone, and so is one whose link was turned off, or whose maker lost the
-- standing to grant it, while it waited.
CREATE OR REPLACE FUNCTION apply_community_invite(p_redemption INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT x.id, x.user_id, i.app_id, i.created_by, i.revoked_at,
         a.community_id, a.collab_visibility, a.self_hosted
    INTO r
    FROM community_invite_redemptions x
    JOIN community_invites i ON i.id = x.invite_id
    JOIN apps a ON a.id = i.app_id
   WHERE x.id = p_redemption AND x.applied_at IS NULL AND x.status <> 'cancelled';
  IF NOT FOUND OR r.revoked_at IS NOT NULL OR r.community_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF NOT community_invite_maker_holds((SELECT invite_id FROM community_invite_redemptions WHERE id = r.id)) THEN
    RETURN FALSE;
  END IF;
  -- Building by invitation: the link is the maker's collaborator invite,
  -- accepted. The collaborator trigger joins the community from this row.
  IF r.collab_visibility = 'private' AND NOT r.self_hosted THEN
    INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at, accepted_via)
    VALUES (r.app_id, r.user_id, 'member', r.created_by, NOW(), 'link')
    ON CONFLICT (app_id, user_id) DO UPDATE
      SET status = 'member', accepted_at = COALESCE(app_collaborators.accepted_at, NOW()),
          accepted_via = 'link'
      WHERE app_collaborators.status <> 'member';
  END IF;
  INSERT INTO community_members (community_id, user_id, source)
  VALUES (r.community_id, r.user_id, 'joined')
  ON CONFLICT (community_id, user_id) DO NOTHING;
  INSERT INTO app_favorites (app_id, user_id) VALUES (r.app_id, r.user_id)
  ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = FALSE;
  UPDATE community_invite_redemptions
     SET status = 'joined', applied_at = NOW()
   WHERE id = r.id;
  RETURN TRUE;
END;
$$;

-- Somebody let in (any path: an admin release, an activation code, a wallet,
-- the invite tree) joins every community their links queued. On the
-- false → true edge only, like join_platform_community above.
CREATE OR REPLACE FUNCTION apply_queued_community_invites() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.has_platform_access THEN
    RETURN NULL;
  END IF;
  PERFORM apply_community_invite(x.id)
     FROM community_invite_redemptions x
    WHERE x.user_id = NEW.id AND x.applied_at IS NULL AND x.status = 'queued';
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_apply_queued_community_invites'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_apply_queued_community_invites
      AFTER UPDATE OF has_platform_access ON users
      FOR EACH ROW WHEN (NEW.has_platform_access)
      EXECUTE FUNCTION apply_queued_community_invites();
  END IF;
END $$;

-- ── Invite opens (WP-E) ───────────────────────────────────────────────
--
-- A section of its own, after "Communities, stage 6", not inside it:
-- tests/community-invites-postgres.test.js runs that block as written in
-- a scratch schema with only the tables it reads, and this one needs
-- notifications.
--
-- WP-E: who has opened a maker's invite links to a project, so "N people
-- opened your invite" counts people, not page loads
-- (services/invite-activity.js). One row per person, per maker and project:
-- their account when they were signed in, else their browser, kept as the
-- SHA-256 of a random HttpOnly cookie (hr_iv) that names nothing and says
-- nothing about where it is. A browser that later opens a link signed in,
-- or joins through one, is given its account, so the person stays one row.
-- `notification_id` is the open notice they are counted on: none for a
-- browser only ever seen signed out, which tells nobody (#4176) until it
-- opens a link signed in. It goes NULL
-- when they join through the maker's link, whose own notice ("Joined
-- through your invite") replaces their open; the row stays, so opening the
-- link again later is still not news. staging:private: it says who looked
-- at whose link.
CREATE TABLE IF NOT EXISTS community_invite_opens (
  id              SERIAL PRIMARY KEY,
  maker_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  browser         VARCHAR(64),
  notification_id INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR browser IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_invite_opens_account
  ON community_invite_opens (maker_id, app_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_invite_opens_browser
  ON community_invite_opens (maker_id, app_id, browser) WHERE browser IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_invite_opens_notice
  ON community_invite_opens (notification_id) WHERE notification_id IS NOT NULL;
COMMENT ON TABLE community_invite_opens IS 'staging:private';

-- ── Platform limit alerts ──────────────────────────────────────────────
--
-- The last level each server-wide cap reached (services/platform-limit-
-- alerts.js): 'ok', 'warn' (at PLATFORM_LIMIT_WARN_PERCENT of the cap) or
-- 'full'. One row per cap ('apps' for MAX_APPS, 'sessions' for
-- MAX_GLOBAL_SESSIONS, 'github' and 'github_app' for GitHub's hourly
-- request budget, which warns at a fifth left), read and written under a
-- row lock in the same transaction that notifies the full admins, so a
-- crossing is announced once however many evaluators race it. used / cap /
-- measured_at are the figures behind the last decision, kept for anybody
-- reading the row.
--
-- Operational state, not a secret, so it is not tagged staging:private.
CREATE TABLE IF NOT EXISTS platform_limit_alerts (
  limit_key   VARCHAR(32) PRIMARY KEY,
  level       VARCHAR(8) NOT NULL DEFAULT 'ok' CHECK (level IN ('ok', 'warn', 'full')),
  used        INTEGER,
  cap         INTEGER,
  measured_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ
);

-- ── Test accounts ──────────────────────────────────────────────────────
--
-- A full platform admin can mint a throwaway account through the connector
-- (create_test_account; services/test-accounts.js) to walk a real first run.
-- It is a real account — it signs in, joins the Homeroom community, can vote —
-- so these columns are what fence it off from real outcomes:
--
--   test_account_created_at   set once, at creation, and never cleared (an
--                             anonymised test account keeps it, so its old
--                             rows still read as a test account's). NULL on
--                             every real account. The partial index serves
--                             the live list and the cap of 25.
--   test_account_created_by   the admin who made it.
--   test_account_welcome_dm   the one opt-in: the welcome DM trigger below
--                             skips test accounts unless this is TRUE, because
--                             the welcome DM puts staff into a group with it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS test_account_created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS test_account_created_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS test_account_welcome_dm BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_test_account_created_at
  ON users (test_account_created_at) WHERE test_account_created_at IS NOT NULL;

-- One-time phone sign-ins for test accounts (services/test-accounts.js
-- mintPhoneSignIn, the connector's create_test_phone_sign_in): a full admin
-- gets a fictional test number (+1 … 555 0100–0199) and a random six-digit
-- code, and the code signs in once, within 30 minutes and five tries, in any
-- environment, production included. The account it makes is a test account
-- (services/firebase-phone-auth.js, TEST NUMBERS). Only the code's bcrypt
-- hash is kept. used_by is the account the code signed in.
CREATE TABLE IF NOT EXISTS test_phone_sign_ins (
  id          BIGSERIAL PRIMARY KEY,
  phone_e164  VARCHAR(16) NOT NULL CHECK (phone_e164 ~ '^\+1[2-9][0-9]{2}55501[0-9]{2}$'),
  code_hash   TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    SMALLINT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  used_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_test_phone_sign_ins_unused
  ON test_phone_sign_ins (phone_e164) WHERE used_at IS NULL;
COMMENT ON TABLE test_phone_sign_ins IS 'staging:private';

-- The retired first-run "Add your phone number" step was answered (#4378
-- retired the step: verification is asked only at a public step now). Kept
-- so existing databases need nothing; nothing reads it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_ask_answered_at TIMESTAMPTZ;

-- VERIFIED IDENTITY (sybil protection for public decisions and the full AI
-- budget). An account is verified by any of: a verified phone
-- (user_phone_identities), BOTH GitHub and X linked (user_social_identities,
-- the "social" identity tier, services/limits.js), or a zkPassport proof
-- (user_activities source 'zkpassport'). GitHub or X alone is not enough:
-- either is free to make in bulk, and the link proves ownership only.
CREATE OR REPLACE FUNCTION identity_verified(target_user_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_phone_identities p WHERE p.user_id = target_user_id)
      OR (EXISTS (SELECT 1 FROM user_social_identities g
                   WHERE g.user_id = target_user_id AND g.provider = 'github')
          AND EXISTS (SELECT 1 FROM user_social_identities x
                       WHERE x.user_id = target_user_id AND x.provider = 'x'))
      OR EXISTS (SELECT 1 FROM user_activities z
                  WHERE z.user_id = target_user_id AND z.source = 'zkpassport')
$$;
-- When the verified-identity rule was switched on (Admin, Limits): the
-- platform_settings row 'identity_rule_since', an ISO timestamp, absent while
-- it is off. A value that is not a timestamp reads as off, never as an error
-- in every tally that calls this.
CREATE OR REPLACE FUNCTION identity_rule_since()
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN ps.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
           THEN ps.value::timestamptz
         END
    FROM platform_settings ps
   WHERE ps.key = 'identity_rule_since'
$$;
-- Exempt from the rule: an account let in before it was switched on (or an
-- admin). Existing members keep their public votes and their AI budget.
CREATE OR REPLACE FUNCTION identity_rule_exempt(target_user_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = target_user_id
       AND (u.is_admin
            OR (u.has_platform_access
                AND COALESCE(u.platform_access_granted_at, u.created_at) < identity_rule_since()))
  )
$$;
-- Whether the rule holds this account to it: on, and the account is neither
-- exempt nor verified. GET /api/auth/me's `identityNeeded`, which asks a new
-- member for a phone (the first-run step, Home's card).
CREATE OR REPLACE FUNCTION identity_needed(target_user_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT identity_rule_since() IS NOT NULL
     AND NOT identity_rule_exempt(target_user_id)
     AND NOT identity_verified(target_user_id)
$$;
-- Whether a vote by `voter_id` on `target_app_id` needs a verified identity
-- to count: the app is PUBLIC (view_visibility 'public') and the rule holds
-- the voter to it (identity_needed above). Private groups' votes are never
-- held to it. The vote routes refuse such a vote first
-- (services/communities.js identityVoteRefusal); counts_toward_outcome
-- leaves it out of every tally and denominator.
CREATE OR REPLACE FUNCTION public_vote_needs_identity(voter_id INTEGER, target_app_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT identity_rule_since() IS NOT NULL
     AND EXISTS (SELECT 1 FROM apps a WHERE a.id = target_app_id AND a.view_visibility = 'public')
     AND identity_needed(voter_id)
$$;

-- Whose vote counts toward an app's outcome (test accounts, D1). Everybody's,
-- except a test account's on an app a real person made: that vote is recorded
-- and shown, labelled, and left out of the tally and of the active-member
-- denominator, so minting accounts can never move a real decision. On an app a
-- test account made, test accounts count like anybody, so one tester can take
-- a project through a vote end to end. The one predicate every tally and the
-- denominator call (services/pr-vote-revision.js countedVotePredicateSql,
-- services/governance.js, services/active-users.js). LANGUAGE sql and STABLE
-- so the planner inlines it.
--
-- A PRIVATE MEMBER (users.private_member_since, not let in yet) never counts
-- on a PUBLIC app (view_visibility 'public', a Public community), even one
-- whose link brought them in: they use public apps, and vote in their own
-- private groups. Invite links are cheap to make, so this keeps them from
-- moving a public decision, and out of its denominator. The vote routes
-- refuse such a vote first (services/communities.js privateVoteRefusal).
--
-- With the verified-identity rule on, a vote on a PUBLIC app counts only
-- from a verified or exempt account (public_vote_needs_identity above).
CREATE OR REPLACE FUNCTION counts_toward_outcome(voter_id INTEGER, target_app_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT (NOT EXISTS (
           SELECT 1 FROM users tv
            WHERE tv.id = voter_id AND tv.test_account_created_at IS NOT NULL
         )
      OR EXISTS (
           SELECT 1 FROM apps ta
             JOIN users tc ON tc.id = ta.created_by
            WHERE ta.id = target_app_id AND tc.test_account_created_at IS NOT NULL
         ))
     AND NOT EXISTS (
           SELECT 1 FROM users pv, apps pa
            WHERE pv.id = voter_id AND pa.id = target_app_id
              AND pv.private_member_since IS NOT NULL
              AND NOT pv.has_platform_access AND NOT pv.is_admin
              AND pa.view_visibility = 'public'
         )
     AND NOT public_vote_needs_identity(voter_id, target_app_id)
$$;
-- The same rule keyed by what was voted on, for the tallies that hold only a
-- proposal's id (services/governance.js qualifiedCounts).
CREATE OR REPLACE FUNCTION counts_toward_session_outcome(voter_id INTEGER, target_session_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT counts_toward_outcome(voter_id, (SELECT cs.app_id FROM chat_sessions cs WHERE cs.id = target_session_id))
$$;
CREATE OR REPLACE FUNCTION counts_toward_issue_outcome(voter_id INTEGER, target_issue_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT counts_toward_outcome(voter_id, (SELECT i.app_id FROM issues i WHERE i.id = target_issue_id))
$$;

-- The Homeroom bot's DM list (platform_settings 'homeroom_bot_dm_users') was
-- kept in step with renames by a trigger; the list is retired, and so is it.
DROP TRIGGER IF EXISTS users_carry_homeroom_bot_dm_member ON users;
DROP FUNCTION IF EXISTS carry_homeroom_bot_dm_member();

-- ── Welcome messages ───────────────────────────────────────────────────
--
-- Somebody let in gets a group conversation with the people an admin
-- chose (#admin/welcome-dm, services/welcome-dm.js), opened by a message
-- from the first of them. This is the queue between the moment and the
-- message: the trigger below writes one row per person on the
-- has_platform_access false → true edge — every path that lets someone in
-- passes through it, like join_platform_community above — and the leader's
-- sweep turns each row into the group and the message.
--
-- The row is written only while the switch is on. Switching it on later
-- does not reach back to everyone let in while it was off, and the primary
-- key means a person revoked and let in again is welcomed once.
--
-- status: 'pending' until the sweep has sent the message; 'sent'; 'skipped'
-- when there was nobody to send it or the person left first (detail says
-- which); 'failed' after MAX_ATTEMPTS. conversation_id is recorded as soon
-- as the group exists, so a retry posts into it rather than opening another.
--
-- staging:private: who joined and the conversation they were put in.
CREATE TABLE IF NOT EXISTS welcome_dm_queue (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  detail          TEXT,
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_welcome_dm_queue_pending
  ON welcome_dm_queue (enqueued_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_welcome_dm_queue_recent
  ON welcome_dm_queue (enqueued_at DESC);
COMMENT ON TABLE welcome_dm_queue IS 'staging:private';

CREATE OR REPLACE FUNCTION enqueue_welcome_dm() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.has_platform_access THEN
    RETURN NULL;
  END IF;
  IF NEW.is_synthetic THEN
    RETURN NULL;
  END IF;
  -- A test account is welcomed only when its creator asked for it.
  IF NEW.test_account_created_at IS NOT NULL AND NOT NEW.test_account_welcome_dm THEN
    RETURN NULL;
  END IF;
  IF COALESCE((SELECT value FROM platform_settings WHERE key = 'welcome_dm_enabled'), 'off') <> 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO welcome_dm_queue (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'users_enqueue_welcome_dm'
       AND tgrelid = 'users'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER users_enqueue_welcome_dm
      AFTER INSERT OR UPDATE OF has_platform_access ON users
      FOR EACH ROW WHEN (NEW.has_platform_access)
      EXECUTE FUNCTION enqueue_welcome_dm();
  END IF;
END $$;

-- The starter template a project was created from (#3521;
-- services/app-templates.js TEMPLATE_IDS, validated by POST /api/apps).
-- Written only for a non-default starter: NULL is `empty`, which is also
-- what every project created before templates existed, every import and
-- every fork reads as. app-creator scaffolds from it, so a Retry after a
-- failed create writes the same starter the creator picked.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR(40);

-- "Suggest this back" (services/suggest-back.js): a proposal opened on an
-- original from one of its remixes records the copy it came from. NULL for
-- every other proposal. The partial unique index is what keeps one copy to
-- one open suggestion at a time, behind the route's own read, so two presses
-- racing past that read cannot both land. ON DELETE SET NULL: deleting the
-- copy leaves the proposal on the original as it is.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS suggested_from_app_id INTEGER
  REFERENCES apps(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_one_open_suggestion
  ON chat_sessions (suggested_from_app_id)
  WHERE suggested_from_app_id IS NOT NULL AND status IN ('active', 'promoted', 'merging');

-- ── App-host sign-in (#3657; services/edge-gate.js) ──────────────────────
--
-- Opening an app at its own address while signed in to Homeroom signs the
-- person in there too: the app host's gate sends the browser to the apex
-- (/__access/authorize), which reads the real platform session and sends it
-- back with a one-minute sign-in code bound to the host, the app, the user
-- and that session. The gate trades the code for a host-only cookie.
--
-- The code is SINGLE-USE. Its `jti` is recorded here the first time it is
-- redeemed (INSERT ... ON CONFLICT DO NOTHING; first writer wins on every
-- platform process at once), and a second presentation finds the row and is
-- refused. Rows are only needed until the code would have expired anyway, so
-- each redemption also clears a bounded batch of expired ones.
CREATE TABLE IF NOT EXISTS edge_grant_redemptions (
  jti          CHAR(32) PRIMARY KEY CHECK (jti ~ '^[0-9a-f]{32}$'),
  expires_at   TIMESTAMPTZ NOT NULL,
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE edge_grant_redemptions IS 'staging:private';
CREATE INDEX IF NOT EXISTS edge_grant_redemptions_expiry_idx
  ON edge_grant_redemptions (expires_at);

-- The app-host cookie names its platform session by a SHA-256 of the
-- session token (never the token itself), and every gated request checks
-- that session is still live, so signing out of Homeroom signs out of every
-- app host at once. This index is that lookup.
CREATE INDEX IF NOT EXISTS sessions_token_sha256_idx
  ON sessions (encode(sha256(token::bytea), 'hex'));

-- A change that went live inside another one (workflow/merge-followups/facts.ts):
-- when a change merges, an open change whose head commit is one of the
-- merged pull request's own commits was built on, so its work is live too.
-- It is marked merged with the merge it went live in (merged_at and
-- merge_commit_sha are that merge's), and this names the change that
-- carried it, so its page says "Live, included in #8" and nothing asks for
-- its vote. NULL for every change that merged on its own. ON DELETE SET
-- NULL: deleting the carrying change leaves this one merged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS included_in_session_id INTEGER
  REFERENCES chat_sessions(id) ON DELETE SET NULL;

-- The inviter's note with an invite by @username (the first session's
-- invite sheet, frontend/src/features/first-session/made.tsx, and
-- POST /api/apps/:slug/invites): their own words, shown on the invite the
-- person accepts, as a link's note is on the page it opens
-- (community_invites.note). Plain text, at most 280 characters; NULL when
-- they left none. services/collab-invites.js sendInvite is the one writer,
-- through community-invites.js cleanNote. Kept once the invite is accepted,
-- like invited_by.
ALTER TABLE app_collaborators ADD COLUMN IF NOT EXISTS invite_note TEXT;
-- #5104: HOW a member row was accepted, for users_connected's consent rule.
-- 'invite' is an invitation the person accepted (collab-invites.js
-- acceptAndPin), 'link' an invite link they redeemed (apply_community_invite).
-- NULL is everything nobody accepted: the creator's own row (the creator is
-- read off apps.created_by instead), dapp.json's declared admins
-- (app-manifest.js applyAdminsChange) and fixtures. The backfill runs once,
-- when the column is added: an existing member with an inviter and an
-- acceptance is taken to have accepted an invitation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'app_collaborators'
       AND column_name = 'accepted_via'
  ) THEN
    ALTER TABLE app_collaborators ADD COLUMN accepted_via VARCHAR(16);
    UPDATE app_collaborators SET accepted_via = 'invite'
     WHERE status = 'member' AND accepted_at IS NOT NULL
       AND invited_by IS NOT NULL AND invited_by <> user_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_collaborators_accepted_via_check' AND conrelid = 'app_collaborators'::regclass
  ) THEN
    ALTER TABLE app_collaborators ADD CONSTRAINT app_collaborators_accepted_via_check
      CHECK (accepted_via IS NULL OR accepted_via IN ('invite', 'link'));
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_collaborators'::regclass
       AND conname = 'app_collaborators_invite_note_length'
  ) THEN
    ALTER TABLE app_collaborators
      ADD CONSTRAINT app_collaborators_invite_note_length
      CHECK (invite_note IS NULL OR char_length(invite_note) BETWEEN 1 AND 280);
  END IF;
END $$;

-- The small-change tag, watch only (services/small-change.js): for each
-- proposal head a checks run settles on, whether the change is clearly small
-- and undoable (a fix, a wording or look change, a small optional addition).
-- Read only by platform admins (GET /api/admin/small-change-tags) while the
-- team watches how it behaves; nothing about votes, merges, checks or cards
-- reads it. One row per (session, head): the unique key is the tagger's
-- cache, and only an 'unavailable' row (no key, a GitHub or model failure)
-- is ever replaced. `vetoes` lists the rule-based reasons that ruled a head
-- out before any model call, in services/small-change.js VETOES order;
-- `reason` is the model's one plain sentence. Private because it hangs off
-- chat_sessions, which is.
CREATE TABLE IF NOT EXISTS small_change_tags (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  app_id         INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  head_sha       VARCHAR(40) NOT NULL,
  verdict        VARCHAR(16) NOT NULL,
  kind           VARCHAR(16),
  reason         TEXT,
  vetoes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_changed  INTEGER,
  lines_changed  INTEGER,
  model          VARCHAR(255),
  cost_usd       NUMERIC(18,8),
  duration_ms    INTEGER,
  error          VARCHAR(64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT small_change_tags_session_head UNIQUE (session_id, head_sha),
  CONSTRAINT small_change_tags_verdict_check
    CHECK (verdict IN ('small', 'not_small', 'vetoed', 'unavailable')),
  CONSTRAINT small_change_tags_kind_check
    CHECK (kind IS NULL OR kind IN ('fix', 'wording', 'look', 'addition'))
);
CREATE INDEX IF NOT EXISTS small_change_tags_created_idx
  ON small_change_tags (created_at DESC, id DESC);
COMMENT ON TABLE small_change_tags IS 'staging:private';

-- Homeroom bot CONFIGURATIONS (services/bot-configs.js): how the bot builds a
-- project's FIRST VERSION, and (scope `later`, below) every later change, as
-- versioned recipes. A recipe names the model of
-- each stage (triage, spec, build), an optional REVIEWER (a model that looks
-- at the build's screenshots and asks for fixes, up to maxRounds rounds
-- within budgetMinutes) and an optional App bench context pack. Each row is
-- one immutable VERSION: editing a configuration saves a new version, and
-- every average is per version, never across them. `role` is what the
-- version does now: `current` builds every live first version (exactly one
-- at a time, the partial unique index), `side` is built silently beside each
-- live first version on the App bench lane for comparison, and `retired` is
-- neither. A later change follows the `later` scope's current version, or
-- the per-stage settings (homeroom-bot.js stageModel) when it has none.
-- `seed_key` makes the deploy's seed idempotent.
-- Not private: admin-written recipes, nothing about anybody's app, and the
-- bot's runs (a public table) name the version that built them.
CREATE TABLE IF NOT EXISTS bot_config_versions (
  id               SERIAL PRIMARY KEY,
  key              TEXT NOT NULL,
  label            TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  recipe           JSONB NOT NULL,
  role             TEXT NOT NULL DEFAULT 'side',
  notes            TEXT,
  seed_key         TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_config_versions_role_check CHECK (role IN ('current', 'side', 'retired')),
  CONSTRAINT bot_config_versions_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT bot_config_versions_version_check CHECK (version > 0),
  UNIQUE (key, version)
);
-- A configuration's SCOPE: `first_version` (how a project's first version
-- is built, every row before scopes) or `later` (every other build the bot
-- makes, live or shadow: its spec and build models). Each scope has exactly
-- one current version, so the one-current index is per scope; it replaces
-- the single one, which a second scope's current would break. A key
-- belongs to one scope.
ALTER TABLE bot_config_versions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'first_version';
DO $$
BEGIN
  ALTER TABLE bot_config_versions DROP CONSTRAINT IF EXISTS bot_config_versions_scope_check;
  ALTER TABLE bot_config_versions ADD CONSTRAINT bot_config_versions_scope_check
    CHECK (scope IN ('first_version', 'later'));
END $$;
DROP INDEX IF EXISTS idx_bot_config_versions_one_current;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_config_versions_one_current_per_scope
  ON bot_config_versions (scope) WHERE role = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_config_versions_seed
  ON bot_config_versions (seed_key) WHERE seed_key IS NOT NULL;

-- A live first version's configuration and its REVIEW (services/bot-review.js):
-- which version built it; `review` the round-0 snapshot (the state after the
-- first build, before any review), every round (its commit, the capture's
-- artifacts, the reviewer's verdict and issues, what it cost and took) and
-- why the loop stopped; `review_rounds` and `review_stop` the two numbers the
-- run listing shows. `review->>'state'` is 'reviewing' (or 'capturing', a
-- recipe with no reviewer whose first build is only captured) while the loop
-- runs, so restart recovery proposes the last committed state rather than
-- calling the build lost. Its captures are kept slim (whether the app booted
-- and where each screenshot is stored); the full ones are private
-- (bot_config_results).
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS bot_config_version_id INTEGER
  REFERENCES bot_config_versions(id) ON DELETE SET NULL;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS review JSONB;
-- The review's issues quote what a private project's screens show, and its
-- rounds name where their screenshots are: private, as plan_change is.
-- review_rounds and review_stop, two numbers, stay public.
COMMENT ON COLUMN homeroom_bot_runs.review IS 'staging:private';
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS review_rounds INTEGER;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS review_stop TEXT;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_runs_reviewing
  ON homeroom_bot_runs(id) WHERE (review->>'state') IN ('reviewing', 'capturing');

-- A SIDE build of a live first version runs on the App bench lane as a trial
-- (services/bot-configs.js spawnSideBuilds): the live run it is compared
-- with, and the configuration version it builds.
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS bot_run_id INTEGER
  REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL;
ALTER TABLE bench_trials ADD COLUMN IF NOT EXISTS bot_config_version_id INTEGER
  REFERENCES bot_config_versions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_trials_side_build
  ON bench_trials(bot_run_id, bot_config_version_id, attempt) WHERE bot_run_id IS NOT NULL;

-- What one configuration version made of one live first version: the
-- current version's from the live build itself (source 'live'), a side
-- version equal to it with no reviewer from the live build's round-0
-- snapshot ('round0'), any other side version from its bench trial
-- ('trial'). Cost and ACTIVE time (queue left out) include the live run's
-- triage, which every configuration shares. `capture` is the screenshot
-- step's summary; its artifact ids name rows in bot_capture_artifacts or
-- bench_trial_artifacts. Private: it describes builds of private projects.
-- A LATER change's (its version's scope) are its own build, live or shadow
-- (source 'live'; the run's mode says which), and each side version's
-- trial ('trial'): no review, so no round-0 result and no capture.
CREATE TABLE IF NOT EXISTS bot_config_results (
  id                 SERIAL PRIMARY KEY,
  bot_run_id         INTEGER NOT NULL REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  config_version_id  INTEGER NOT NULL REFERENCES bot_config_versions(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,
  trial_id           INTEGER REFERENCES bench_trials(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  built              BOOLEAN,
  booted             BOOLEAN,
  cost_usd           NUMERIC(18,8),
  active_ms          BIGINT,
  sha                TEXT,
  capture            JSONB,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT bot_config_results_source_check CHECK (source IN ('live', 'round0', 'trial')),
  CONSTRAINT bot_config_results_status_check CHECK (status IN ('pending', 'done', 'skipped')),
  UNIQUE (bot_run_id, config_version_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_config_results_version ON bot_config_results(config_version_id, status);
CREATE INDEX IF NOT EXISTS idx_bot_config_results_trial ON bot_config_results(trial_id) WHERE trial_id IS NOT NULL;
COMMENT ON TABLE bot_config_results IS 'staging:private';
-- What the cost was made of (services/stage-costs.js breakdown): each stage
-- (triage, spec, build, the review's reviewer calls and fix turns) with its
-- model and dollars, and the remainder no stage names. Null on a result
-- recorded before stages were.
ALTER TABLE bot_config_results ADD COLUMN IF NOT EXISTS cost_parts JSONB;

-- A blind PAIR: the current version's result and one side version's, from
-- the same live first version, for an admin's pick (left, right or a tie)
-- through the connector. `left_is_current` is drawn at random when the pair
-- is made and never shown; `token` is the only id a picker sees. A pair
-- where either side did not build or boot is `excluded` with why, never
-- offered, and counted in the stats as that.
CREATE TABLE IF NOT EXISTS bot_config_pairs (
  id                 SERIAL PRIMARY KEY,
  token              TEXT NOT NULL UNIQUE,
  bot_run_id         INTEGER NOT NULL REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  current_result_id  INTEGER NOT NULL REFERENCES bot_config_results(id) ON DELETE CASCADE,
  side_result_id     INTEGER NOT NULL REFERENCES bot_config_results(id) ON DELETE CASCADE,
  left_is_current    BOOLEAN NOT NULL,
  status             TEXT NOT NULL DEFAULT 'waiting',
  excluded_reason    TEXT,
  pick               TEXT,
  note               TEXT,
  picked_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_config_pairs_status_check CHECK (status IN ('waiting', 'excluded', 'picked')),
  CONSTRAINT bot_config_pairs_pick_check CHECK (pick IS NULL OR pick IN ('current', 'side', 'tie')),
  UNIQUE (current_result_id, side_result_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_config_pairs_waiting ON bot_config_pairs(id) WHERE status = 'waiting';
COMMENT ON TABLE bot_config_pairs IS 'staging:private';

-- The review loop's screenshots (services/bot-review.js): one row per image
-- of one round's capture, of a live run or of a bench trial whose recipe has
-- a reviewer, stored as bench_trial_artifacts stores a trial's final ones.
-- Private: an app's screens can show any of its data.
CREATE TABLE IF NOT EXISTS bot_capture_artifacts (
  id            VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  bot_run_id    INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  trial_id      INTEGER REFERENCES bench_trials(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL CHECK (round >= 0),
  shot_id       VARCHAR(64) NOT NULL,
  viewport      VARCHAR(16) NOT NULL,
  look          VARCHAR(8) NOT NULL CHECK (look IN ('light', 'dark')),
  -- Any state the screenshot step plans (services/bench/capture.js STATES),
  -- so a state it adds later needs no change here.
  state         VARCHAR(16) NOT NULL CHECK (state ~ '^[a-z][a-z_]{0,15}$'),
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA NOT NULL,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  sha256        VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_capture_artifacts_owner_check CHECK ((bot_run_id IS NULL) <> (trial_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_bot_capture_artifacts_run ON bot_capture_artifacts(bot_run_id, round) WHERE bot_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_capture_artifacts_trial ON bot_capture_artifacts(trial_id, round) WHERE trial_id IS NOT NULL;
-- Kept about 30 days, unless a pair still waiting for a pick shows them
-- (services/bot-configs.js pruneCaptureArtifacts).
CREATE INDEX IF NOT EXISTS idx_bot_capture_artifacts_created ON bot_capture_artifacts(created_at);
COMMENT ON TABLE bot_capture_artifacts IS 'staging:private';

-- #4387: what a first version's App tab shows while it is built
-- (services/first-version-screens.js). The FIRST LOOK, the spec's main
-- drawn screen rendered to a phone-sized PNG in the build's worker, from
-- "Building it"; then up to three REAL screens of the build, kept from its
-- review's last capture, from "Testing it". Images only, never the model's
-- HTML; read back only by the project's members (GET
-- /api/apps/:slug/first-version/screens/:kind/:n). Private: an app's
-- screens can show any of its data.
CREATE TABLE IF NOT EXISTS first_version_screens (
  id            VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  bot_run_id    INTEGER NOT NULL REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  kind          VARCHAR(16) NOT NULL CHECK (kind IN ('first_look', 'real')),
  position      SMALLINT NOT NULL CHECK (position >= 0 AND position < 3),
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA NOT NULL,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bot_run_id, kind, position)
);
COMMENT ON TABLE first_version_screens IS 'staging:private';
-- Newcomer run six (14 Oct 2026): a first version's EARLY first look
-- (services/first-version-early-look.js). Its main screen, drawn from the
-- plan written at Make it in one short model call while the project is set
-- up (the plan's suggested answers stand in for the ones not given yet), and
-- rendered to a phone-sized PNG in the worker of the app's bot session, as
-- the spec's screens are. Kept by project, since there is no run yet: the
-- App tab reads it as the first look (first-version-screens.js showcaseOf)
-- until the build's spec saves its own, and that spec starts its main screen
-- from `screen`. `status` is pending while it is drawn, drawn once the model
-- answered, ready with its picture, failed without one (`error` says why).
-- `screen` is the model's <template data-screen>, read only by the platform
-- (the spec's prompt) and never served; `png` is read back only by the
-- project's members. Private: a drawn screen shows what its maker described.
CREATE TABLE IF NOT EXISTS first_version_early_looks (
  app_id        INTEGER PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  status        VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'drawn', 'ready', 'failed')),
  model         TEXT,
  screen        TEXT,
  png           BYTEA,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER CHECK (bytes IS NULL OR bytes > 0),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drawn_at      TIMESTAMPTZ,
  saved_at      TIMESTAMPTZ
);
COMMENT ON TABLE first_version_early_looks IS 'staging:private';
-- #4387: the build agent's latest "Adding …" phrase (usernode-progress),
-- the App tab's build line note while a first version is built.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_caption TEXT;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_caption_at TIMESTAMPTZ;
-- What started a run's read: its queue row's reason ('new', 'changed',
-- 'retry_failed', 'restart', 'read_again', 'checks_failing', 'cap_freed',
-- 'app_again', 'admin', …), and for 'changed' what moved past the last
-- read, 'changed:github' (the issue's updated_at: a comment, an edit, a
-- label) or 'changed:discussion' (a person's message in its Homeroom
-- thread or its proposal's). One request was read six times in a week and
-- the ledger could not say why. `changed_by` carries that from the
-- refresh that queued it (homeroom-bot.js classifyIssue). Null on a run
-- from before, or one no queue row started.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS read_reason TEXT;
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS changed_by TEXT;
-- A reply whose verdict could not be read, kept whole enough to read why:
-- { reply: { text, chars }, repair: { text, chars } | null }, each text its
-- first 4 KB and last 12 KB (homeroom-bot.js keptReply), `repair` the reply
-- to the one turn that asked for the JSON block. The run's error stays one
-- short line; 17 such failures in a week left only a clipped 300-character
-- tail to read. Shown to admins beside that error (the console's run row,
-- the connector's get_homeroom_bot). Null on every other run.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS unreadable_reply JSONB;
-- What a read saw of its request (homeroom-bot.js readFingerprintOf): a
-- hash of its title, body, GitHub comments and discussion messages (the
-- screenshots they link included), the bot's own posts left out, with a
-- few counts beside it. A ready verdict a cap held is reused when its turn
-- comes (cap_freed) if the request still hashes the same: no new read, and
-- the new run names the one it reused in `reused_run_id`, at no cost. Null
-- on a run from before, or one that read nothing.
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS read_fingerprint JSONB;
ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS reused_run_id INTEGER
  REFERENCES homeroom_bot_runs(id) ON DELETE SET NULL;
-- #4533: why a queued row is waiting, and until when, as the refusal that
-- left it there said (homeroom-bot.js recordRefusal; 'session_busy' when a
-- turn was running on its session). A refusal keeps the row and its place,
-- so without these a follow-up backing off for an hour looked like one next
-- in line. Read by the console's queue and get_homeroom_bot (queueWait),
-- and only while wait_until is still ahead.
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE homeroom_bot_queue ADD COLUMN IF NOT EXISTS wait_until TIMESTAMPTZ;

-- #4449: LIVE, the new app itself taking shape while a first version is
-- built (services/first-version-live.js). A watcher in the build's worker
-- boots the app on every change and records it with rrweb; what it records
-- is SANITISED (no URL but data:, no script) before it is kept here, and
-- read back only by the project's members (GET
-- /api/apps/:slug/first-version/live). Per run: the restarts kept and
-- failed, and why the watcher stopped (the run's numbers, also recorded as
-- a `live_build_stream` event once its build turn ends).
CREATE TABLE IF NOT EXISTS first_version_live (
  bot_run_id       INTEGER PRIMARY KEY REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  next_seq         INTEGER NOT NULL DEFAULT 1,
  -- The chunk the latest good restart's recording starts at: a viewer
  -- behind it starts over from there.
  base_seq         INTEGER,
  bytes            INTEGER NOT NULL DEFAULT 0,
  restarts_kept    INTEGER NOT NULL DEFAULT 0,
  restarts_failed  INTEGER NOT NULL DEFAULT 0,
  good_at          TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  event_at         TIMESTAMPTZ,
  stopped_why      VARCHAR(32),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);
COMMENT ON TABLE first_version_live IS 'staging:private';
-- The latest good restart's events (kind 'full') and what was recorded on
-- it since ('inc'), at most about 2 MB a run. Private: a recording shows
-- the app's data.
CREATE TABLE IF NOT EXISTS first_version_live_chunks (
  bot_run_id  INTEGER NOT NULL REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        VARCHAR(8) NOT NULL CHECK (kind IN ('full', 'inc')),
  events      JSONB NOT NULL,
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bot_run_id, seq)
);
COMMENT ON TABLE first_version_live_chunks IS 'staging:private';

-- ===================================================================
-- Workflow foundation: the kernel's tables (src/workflow/kernel/).
--
-- Long-lived workflows run as persistent state machines. Routes, services,
-- timers and other instances APPEND events to one stream (wf_events); only
-- the transition pipeline applies them, one instance at a time under that
-- instance's row lock, and writes the outcome (state, receipt, work,
-- messages) in the same transaction. Every write the pipeline makes carries
-- the writer marker `SET LOCAL app.wf_writer = 'transition'`, and the
-- triggers below refuse instance, receipt and processed-event writes made
-- without it. The marker guards against accidents, not against an attacker:
-- no role or credential is involved.
--
-- Every row here can carry votes, actors and proposal payloads, so all of
-- these tables are private to staging clones.
-- ===================================================================

-- One row per machine instance. `state` is the phase name, `data` its
-- payload; `version` counts accepted transitions and `machine_version` is
-- the definition version that last wrote the row, so an older process
-- never applies events to an instance a newer one has written. The
-- pseudo-state '(none)' is a row the pipeline inserted to lock an instance
-- that does not exist yet; it is deleted again unless a creating event is
-- accepted, or kept to carry a stalled or faulted flag when that event
-- timed out or threw. app_id has no foreign key on purpose: an instance's history
-- outlives the app row, like receipts outlive what they describe.
CREATE TABLE IF NOT EXISTS wf_instances (
  machine          TEXT NOT NULL,
  key              TEXT NOT NULL,
  app_id           INTEGER,
  state            TEXT NOT NULL,
  data             JSONB,
  version          BIGINT NOT NULL DEFAULT 0,
  machine_version  INTEGER NOT NULL,
  deadline_at      TIMESTAMPTZ,
  deadline_event   JSONB,
  deadline_version BIGINT,
  flag             TEXT CHECK (flag IN ('faulted', 'stalled')),
  flag_detail      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (machine, key),
  CONSTRAINT wf_instances_deadline_shape
    CHECK ((deadline_at IS NULL) = (deadline_event IS NULL))
);
CREATE INDEX IF NOT EXISTS wf_instances_state_idx ON wf_instances (machine, state);
-- Faulted and stalled instances, read by Admin → Workflows and by every
-- scrape of the workflow's metrics (src/workflow/metrics.ts).
CREATE INDEX IF NOT EXISTS wf_instances_flag_idx ON wf_instances (flag) WHERE flag IS NOT NULL;
CREATE INDEX IF NOT EXISTS wf_instances_app_idx ON wf_instances (app_id, machine);
CREATE INDEX IF NOT EXISTS wf_instances_deadline_idx
  ON wf_instances (deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS wf_instances_flag_idx
  ON wf_instances (flag) WHERE flag IS NOT NULL;
COMMENT ON TABLE wf_instances IS 'staging:private';

-- The stream and, once processed, each instance's history. Anyone may
-- append a pending event; only the pipeline may process it. `attempts`
-- counts lock and statement timeouts (the event goes back to pending with
-- `retry_at`); `error` keeps the last fault even after an admin release
-- retries the event. `held` events wait behind a faulted one.
CREATE TABLE IF NOT EXISTS wf_events (
  id              BIGSERIAL PRIMARY KEY,
  machine         TEXT NOT NULL,
  key             TEXT NOT NULL,
  app_id          INTEGER,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  source          JSONB NOT NULL,
  actor           TEXT,
  request_key     TEXT NOT NULL,
  caused_by       BIGINT REFERENCES wf_events(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processed', 'held')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  retry_at        TIMESTAMPTZ,
  result          TEXT CHECK (result IN ('accepted', 'rejected', 'replayed', 'faulted')),
  reason          TEXT,
  error           JSONB,
  machine_version INTEGER,
  state_before    TEXT,
  state_after     TEXT,
  version_after   BIGINT,
  emitted         JSONB,
  reply           JSONB,           -- the machine's answer to the producer (kernel reply hook)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  CONSTRAINT wf_events_processed_shape
    CHECK ((status = 'processed') = (result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS wf_events_pending_idx
  ON wf_events (machine, key, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wf_events_instance_idx ON wf_events (machine, key, id);
CREATE INDEX IF NOT EXISTS wf_events_caused_by_idx
  ON wf_events (caused_by) WHERE caused_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS wf_events_processed_at_idx
  ON wf_events (processed_at) WHERE status = 'processed';
COMMENT ON TABLE wf_events IS 'staging:private';

-- The stored outcome of an accepted request. A later event with the same
-- (machine, key, request_key) and the same payload hash replays it; a
-- different hash is a request_key_conflict. Rejections write no receipt.
CREATE TABLE IF NOT EXISTS wf_receipts (
  machine      TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_key  TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  outcome      JSONB NOT NULL,
  event_id     BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (machine, key, request_key)
);
COMMENT ON TABLE wf_receipts IS 'staging:private';

-- Durable I/O requested by a transition, executed by a service. A service
-- claims a row (claim_id + lease), may checkpoint under the claim, and on
-- finishing marks it `reported` and appends the result event; the pipeline
-- marks it `settled` when it applies that event. (machine, key, kind,
-- work_key) is unique, so re-emitting a work key creates nothing.
CREATE TABLE IF NOT EXISTS wf_work (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine       TEXT NOT NULL,
  key           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  work_key      TEXT NOT NULL,
  input         JSONB NOT NULL,
  checkpoint    JSONB,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'reported', 'settled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_id      UUID,
  lease_until   TIMESTAMPTZ,
  due_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error    JSONB,
  result        JSONB,
  caused_by     BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at    TIMESTAMPTZ,
  CONSTRAINT wf_work_identity UNIQUE (machine, key, kind, work_key),
  CONSTRAINT wf_work_claim_shape
    CHECK ((status = 'running') = (claim_id IS NOT NULL AND lease_until IS NOT NULL))
);
-- Claims whose process went before reporting (it died, or stopped and gave
-- the lease up): a resumable handler's tries count only the others.
ALTER TABLE wf_work ADD COLUMN IF NOT EXISTS lost_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS wf_work_due_idx
  ON wf_work (kind, due_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS wf_work_instance_idx ON wf_work (machine, key, created_at);
CREATE INDEX IF NOT EXISTS wf_work_settled_idx
  ON wf_work (settled_at) WHERE status = 'settled';
COMMENT ON TABLE wf_work IS 'staging:private';

-- One row per claim of a work item. id is the claim id.
CREATE TABLE IF NOT EXISTS wf_work_attempts (
  id           UUID PRIMARY KEY,
  work_id      UUID NOT NULL REFERENCES wf_work(id) ON DELETE CASCADE,
  service_id   TEXT NOT NULL,
  number       INTEGER NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'running'
                 CHECK (outcome IN ('running', 'succeeded', 'failed', 'retry', 'exhausted', 'lost')),
  error        JSONB,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  UNIQUE (work_id, number)
);
COMMENT ON TABLE wf_work_attempts IS 'staging:private';
-- Attempts lost lately (a lease that lapsed, a stop, a cancel), read by
-- Admin -> Workflows and the workflow's metrics (src/workflow/metrics.ts).
CREATE INDEX IF NOT EXISTS wf_work_attempts_lost_idx ON wf_work_attempts (finished_at) WHERE outcome = 'lost';

-- Kernel settings, written at boot (src/workflow/platform.ts):
-- 'enabled:<machine>' switches the machine's ownership guards on. Every
-- boot writes it for every machine (each is the only path for what it
-- decides); a database no process has booted on yet has none, so its
-- guards are off.
CREATE TABLE IF NOT EXISTS wf_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE wf_settings IS 'staging:private';
-- Retired with the machines' flags: the ownership "log mode" (a write
-- outside a machine allowed and recorded instead of refused) and its record.
DELETE FROM wf_settings WHERE key = 'ownership_mode';
DROP TABLE IF EXISTS wf_ownership_violations;

-- Kernel tables: instances and receipts are written only with the marker;
-- events may be appended by anyone, but only as plain pending events, and
-- only the pipeline changes or deletes them.
CREATE OR REPLACE FUNCTION wf_require_writer() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.wf_writer', true) IS DISTINCT FROM 'transition' THEN
    -- Nested: plpgsql does not short-circuit, and only wf_events has these fields.
    IF TG_TABLE_NAME = 'wf_events' AND TG_OP = 'INSERT' THEN
      IF NEW.status = 'pending' AND NEW.result IS NULL AND NEW.attempts = 0 THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'WF_OWNERSHIP_VIOLATION: % on % outside the transition pipeline',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wf_instances_writer ON wf_instances;
CREATE TRIGGER wf_instances_writer
  BEFORE INSERT OR UPDATE OR DELETE ON wf_instances
  FOR EACH ROW EXECUTE FUNCTION wf_require_writer();
DROP TRIGGER IF EXISTS wf_receipts_writer ON wf_receipts;
CREATE TRIGGER wf_receipts_writer
  BEFORE INSERT OR UPDATE OR DELETE ON wf_receipts
  FOR EACH ROW EXECUTE FUNCTION wf_require_writer();
DROP TRIGGER IF EXISTS wf_events_writer ON wf_events;
CREATE TRIGGER wf_events_writer
  BEFORE INSERT OR UPDATE OR DELETE ON wf_events
  FOR EACH ROW EXECUTE FUNCTION wf_require_writer();

-- Legacy columns a machine owns (its projection). Attach per table with the
-- owned paths as arguments, `column` or `column.jsonKey`, and a WHEN clause
-- for the rows the machine owns, for example:
--   CREATE TRIGGER issues_wf_owned BEFORE UPDATE ON issues FOR EACH ROW
--     WHEN (OLD.kind IN ('rename', ...))
--     EXECUTE FUNCTION wf_guard_owned_columns('status', 'payload.appliedAt');
-- An UPDATE that changes an owned path without the writer marker raises.
--
-- A first argument '@enrolled=<machine>/<key prefix>' limits the guard to
-- rows whose instance exists (key = prefix || id), and only while the
-- machine's guard is on (wf_settings 'enabled:<machine>', see wf_settings
-- above; wf_holds asks the same question). A machine owns a row from the
-- moment it enrolls it.
--
-- A first argument '@enabled=<machine>' guards every row the trigger's WHEN
-- clause selects, but only while the machine is switched on: for a change
-- only the machine may make, whether or not the row is enrolled yet (the
-- move of a proposal into 'merged' is what enrolls it).
-- Whether a machine holds this instance and is on: what an `@enrolled=`
-- guard below checks before it guards a row. Code outside the machine that
-- must leave such a row alone (a legacy migration, a backfill) asks the same
-- question in its WHERE clause, so the two cannot disagree.
-- An instance a machine has handed back holds nothing: 'detached' (left by
-- the preview machine's flag, before its old paths were deleted) and the
-- preview machine's 'retired' (a retired preview's row is the old paths' again, as
-- an unarchived proposal's must be until its next event).
CREATE OR REPLACE FUNCTION wf_holds(machine_name TEXT, instance_key TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM wf_settings WHERE key = 'enabled:' || machine_name)
     AND EXISTS (SELECT 1 FROM wf_instances WHERE machine = machine_name AND key = instance_key
                    AND NOT (state = 'detached' OR (machine_name = 'preview' AND state = 'retired')))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION wf_guard_owned_columns() RETURNS TRIGGER AS $$
DECLARE
  owned TEXT;
  col TEXT;
  sub TEXT;
  before JSONB;
  after JSONB;
  enrolled TEXT;
BEGIN
  IF current_setting('app.wf_writer', true) = 'transition' THEN
    RETURN NEW;
  END IF;
  before := to_jsonb(OLD);
  after := to_jsonb(NEW);
  IF TG_ARGV[0] LIKE '@enabled=%' THEN
    IF NOT EXISTS (SELECT 1 FROM wf_settings
                    WHERE key = 'enabled:' || substr(TG_ARGV[0], length('@enabled=') + 1)) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_ARGV[0] LIKE '@enrolled=%' THEN
    enrolled := substr(TG_ARGV[0], length('@enrolled=') + 1);
    IF NOT wf_holds(split_part(enrolled, '/', 1), split_part(enrolled, '/', 2) || (before ->> 'id')) THEN
      RETURN NEW;
    END IF;
  END IF;
  FOREACH owned IN ARRAY TG_ARGV LOOP
    CONTINUE WHEN owned LIKE '@%';
    col := split_part(owned, '.', 1);
    sub := NULLIF(split_part(owned, '.', 2), '');
    IF (sub IS NULL AND (after -> col) IS DISTINCT FROM (before -> col))
       OR (sub IS NOT NULL AND (after -> col -> sub) IS DISTINCT FROM (before -> col -> sub)) THEN
      RAISE EXCEPTION 'WF_OWNERSHIP_VIOLATION: %.% is owned by a workflow machine', TG_TABLE_NAME, owned;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- governance-proposal (src/workflow/governance-proposal/) owns a governance
-- row's status and audit keys once the row is enrolled. The kinds are
-- services/governance-kinds.js's list (pinned by
-- tests/workflow-governance-postgres.test.js); general request twins are
-- never owned.
DROP TRIGGER IF EXISTS issues_wf_governance_owned ON issues;
CREATE TRIGGER issues_wf_governance_owned
  BEFORE UPDATE ON issues
  FOR EACH ROW
  WHEN (OLD.kind IN ('secret_change', 'rename', 'close_issue', 'maintenance_campaign', 'featured_illustration'))
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=governance-proposal/issue:', 'status',
    'payload.appliedAt', 'payload.appliedBy', 'payload.withdrawnAt', 'payload.supersededAt');

-- merge-followups (src/workflow/merge-followups/): what a merged pull
-- request still has to do once GitHub has merged it (deliver it, tear down
-- its preview, close its requests, include the changes it carried, tell
-- people). One instance per merged proposal, created by the merge.
--
-- live_at: when production first ran a revision containing this change.
-- NULL while it is merged but not live yet ("going live"), or when its
-- deploy failed. The machine sets it. The backfill gives rows merged before
-- the column the reading they always had (merged was live), and leaves
-- alone any row the machine holds.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ;
-- booted_shas: the platform's own row only. The builds platform processes
-- booted with, newest first, at most ten: [{ "sha": ..., "at": ... }].
-- Written by each process that serves requests, once it listens
-- (src/workflow/platform.ts releaseServing; never a conductor), never by
-- the migration Job: main_sha is seeded from the incoming release's GIT_SHA
-- by the migration that runs BEFORE the rollout, so it can name a build that
-- does not serve yet. A history, not the last boot: during a rollout an
-- older Pod can boot after a newer one, and the newer build still ran. A
-- merge recovery records late checks the builds booted since it merged
-- (merge-followups), since live_at is when production first ran it.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS booted_shas JSONB NOT NULL DEFAULT '[]'::jsonb;
-- When an app's teardown began removing it (services/app-teardown.js): the
-- row goes last, so until then the app reads as one whose runtime is missing.
-- The heal sweep leaves it alone, and a deploy that finishes meanwhile
-- removes what it put back, in every process. Set after its previews are
-- retired (the step that may refuse); never cleared, since an app past it is
-- half removed.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS teardown_started_at TIMESTAMPTZ;
UPDATE chat_sessions cs SET live_at = COALESCE(cs.merged_at, cs.created_at, NOW())
 WHERE cs.status = 'merged' AND cs.live_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM wf_instances w
                    WHERE w.machine = 'merge-followups' AND w.key = 'session:' || cs.id);

-- A row INSERTED as merged (seeds, fixtures, history) reads as live: it was
-- never the machine's, and no guard covers an insert. Only the machine (the
-- transition pipeline's writer marker) makes a merged row that is not live
-- yet, and only it moves a row into 'merged' (chat_sessions_wf_merged), so
-- the move writes live_at itself; the trigger that filled it on a move made
-- elsewhere is gone.
CREATE OR REPLACE FUNCTION chat_sessions_inserted_merged_live() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.wf_writer', true) IS DISTINCT FROM 'transition' THEN
    NEW.live_at := COALESCE(NEW.merged_at, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS chat_sessions_inserted_merged_live ON chat_sessions;
CREATE TRIGGER chat_sessions_inserted_merged_live
  BEFORE INSERT ON chat_sessions
  FOR EACH ROW
  WHEN (NEW.status = 'merged' AND NEW.live_at IS NULL)
  EXECUTE FUNCTION chat_sessions_inserted_merged_live();
DROP TRIGGER IF EXISTS chat_sessions_merged_live ON chat_sessions;

-- Only the machine moves a proposal into 'merged' (the merge appends an
-- event; recovery appends the same one), and once it holds a row it owns
-- the merge's columns. One write is not the machine's and is let through:
-- included_in_session_id set to NULL, which is the foreign key's own
-- ON DELETE SET NULL when the change that carried it is deleted (a demo
-- reset deletes the partner's changes, which may have carried another).
DROP TRIGGER IF EXISTS chat_sessions_wf_merged ON chat_sessions;
CREATE TRIGGER chat_sessions_wf_merged
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'merged' AND NEW.status = 'merged')
  EXECUTE FUNCTION wf_guard_owned_columns('@enabled=merge-followups', 'status');
DROP TRIGGER IF EXISTS chat_sessions_wf_merge_owned ON chat_sessions;
CREATE TRIGGER chat_sessions_wf_merge_owned
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  WHEN (OLD.merged_at IS DISTINCT FROM NEW.merged_at
        OR OLD.merge_commit_sha IS DISTINCT FROM NEW.merge_commit_sha
        OR (OLD.included_in_session_id IS DISTINCT FROM NEW.included_in_session_id AND NEW.included_in_session_id IS NOT NULL)
        OR OLD.live_at IS DISTINCT FROM NEW.live_at)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=merge-followups/session:',
    'merged_at', 'merge_commit_sha', 'included_in_session_id', 'live_at');

-- app-delivery (src/workflow/app-delivery/): an app's production deploys,
-- one at a time per app, for everyone who asks (a merge, a secret change,
-- the drift poller, an admin's Redeploy, heal, rollover, a demo reset).
--
-- deploy_state: 'deploying' while a deploy of the app runs, NULL otherwise;
-- deploy_started_at and deploy_from_sha say since when and from which
-- revision. The machine's projection: the version pill, heal, rollover and
-- the drift poller read it (services/app-deploy-status.js, which also keeps
-- rollover's respawn of an existing image in one process's memory).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS deploy_state TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS deploy_from_sha TEXT;
DROP TRIGGER IF EXISTS apps_wf_delivery_owned ON apps;
CREATE TRIGGER apps_wf_delivery_owned
  BEFORE UPDATE ON apps
  FOR EACH ROW
  WHEN (OLD.deploy_state IS DISTINCT FROM NEW.deploy_state
        OR OLD.deploy_started_at IS DISTINCT FROM NEW.deploy_started_at
        OR OLD.deploy_from_sha IS DISTINCT FROM NEW.deploy_from_sha)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=app-delivery/app:',
    'deploy_state', 'deploy_started_at', 'deploy_from_sha');

-- main-check (src/workflow/main-check/): the unit suite on each new main,
-- one instance per app. For an app it holds, it owns the main_check_*
-- columns (its projection: the merge gate's pause, the board's banner).
DROP TRIGGER IF EXISTS apps_wf_main_check_owned ON apps;
CREATE TRIGGER apps_wf_main_check_owned
  BEFORE UPDATE ON apps
  FOR EACH ROW
  WHEN (OLD.main_check_state IS DISTINCT FROM NEW.main_check_state
        OR OLD.main_check_sha IS DISTINCT FROM NEW.main_check_sha
        OR OLD.main_check_at IS DISTINCT FROM NEW.main_check_at
        OR OLD.main_check_detail IS DISTINCT FROM NEW.main_check_detail
        OR OLD.main_check_paused_sha IS DISTINCT FROM NEW.main_check_paused_sha
        OR OLD.main_check_resumed_sha IS DISTINCT FROM NEW.main_check_resumed_sha)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=main-check/app:',
    'main_check_state', 'main_check_sha', 'main_check_at', 'main_check_detail',
    'main_check_paused_sha', 'main_check_resumed_sha');

-- Carry the derived pauses over. Idempotent: only rows that are red, not
-- resumed for that red, not a red of known flakes alone, and not yet
-- carrying the pause column, on rows the main-check machine does not hold
-- (it owns the column there).
UPDATE apps
   SET main_check_paused_sha = main_check_sha
 WHERE main_check_state = 'failing'
   AND main_check_sha IS NOT NULL
   AND main_check_paused_sha IS NULL
   AND lower(coalesce(main_check_resumed_sha, '')) <> lower(main_check_sha)
   AND (main_check_detail -> 'flakesOnly') IS NULL
   AND NOT wf_holds('main-check', 'app:' || id);

-- preview (src/workflow/preview/): a proposal's preview and its required
-- checks, one instance per session. For a session it holds, it owns the
-- preview's columns (what serves, from the serving attempt's receipt) and
-- the checks' (which revision the verdict is for, and the verdict), and
-- writes them in the transition that decides. checks_progress and
-- check_phase stay the run's progress stream (a run says while it waits for
-- a checks slot, and when it starts testing) and are not guarded. A seed in
-- migrate.js leaves a row the machine holds alone (wf_holds).
DROP TRIGGER IF EXISTS chat_sessions_wf_preview_owned ON chat_sessions;
CREATE TRIGGER chat_sessions_wf_preview_owned
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  WHEN (OLD.staging_url IS DISTINCT FROM NEW.staging_url
        OR OLD.staging_container_id IS DISTINCT FROM NEW.staging_container_id
        OR OLD.staging_image_ref IS DISTINCT FROM NEW.staging_image_ref
        OR OLD.staging_build_ref IS DISTINCT FROM NEW.staging_build_ref
        OR OLD.staging_runtime_kind IS DISTINCT FROM NEW.staging_runtime_kind
        OR OLD.staging_runtime_name IS DISTINCT FROM NEW.staging_runtime_name
        OR OLD.staging_commit_sha IS DISTINCT FROM NEW.staging_commit_sha
        OR OLD.checks_commit_sha IS DISTINCT FROM NEW.checks_commit_sha
        OR OLD.check_state IS DISTINCT FROM NEW.check_state
        OR OLD.test_results IS DISTINCT FROM NEW.test_results
        OR OLD.check_error_detail IS DISTINCT FROM NEW.check_error_detail
        OR OLD.consecutive_check_failures IS DISTINCT FROM NEW.consecutive_check_failures
        OR OLD.check_next_retry_at IS DISTINCT FROM NEW.check_next_retry_at
        OR OLD.console_check_state IS DISTINCT FROM NEW.console_check_state
        OR OLD.capture_state IS DISTINCT FROM NEW.capture_state)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=preview/session:',
    'staging_url', 'staging_container_id', 'staging_image_ref', 'staging_build_ref', 'staging_runtime_kind',
    'staging_runtime_name', 'staging_commit_sha', 'checks_commit_sha', 'check_state',
    'test_results', 'check_error_detail', 'consecutive_check_failures', 'check_next_retry_at',
    'console_check_state', 'capture_state');

-- shots (src/workflow/shots/) owns a proposal's before & after shots once it
-- holds the proposal: the slot on chat_sessions and every run row. Every
-- writer is the machine's transition (the declarations, the runs, the
-- waivers); the retention prune and the cascades only delete. A staging seed
-- inserts its fixture runs for proposals the machine does not hold.
DROP TRIGGER IF EXISTS chat_sessions_wf_shots_owned ON chat_sessions;
CREATE TRIGGER chat_sessions_wf_shots_owned
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  WHEN (OLD.shots_state IS DISTINCT FROM NEW.shots_state
        OR OLD.shots_run_id IS DISTINCT FROM NEW.shots_run_id
        OR OLD.shots_detail IS DISTINCT FROM NEW.shots_detail
        OR OLD.shots_updated_at IS DISTINCT FROM NEW.shots_updated_at)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=shots/session:',
    'shots_state', 'shots_run_id', 'shots_detail', 'shots_updated_at');

-- proposal (src/workflow/proposal/) owns a proposal's lifecycle once it
-- holds the proposal: its status (every move but the one into 'merged',
-- which merge-followups makes with the merge) and the columns that move with
-- it: when it went up for a vote, when it closed, its stale warning, its
-- merge attempt, the electorate it opened with, and what the group votes on
-- (the reviewed head and the approval epoch). Since the merge (step 6) it
-- also owns the once-records of the platform's own syncs with main, written
-- with the sync's work (a boot failure's head, a fixed check's head and keys,
-- rule C's one resolution per epoch). INSERTs are not guarded: a session is
-- created where it always was, and a row born in review is adopted in the
-- inserting transaction.
DROP TRIGGER IF EXISTS chat_sessions_wf_proposal_owned ON chat_sessions;
CREATE TRIGGER chat_sessions_wf_proposal_owned
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW
  WHEN ((OLD.status IS DISTINCT FROM NEW.status AND NEW.status IS DISTINCT FROM 'merged')
        OR OLD.promoted_at IS DISTINCT FROM NEW.promoted_at
        OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
        OR OLD.stale_notified_at IS DISTINCT FROM NEW.stale_notified_at
        OR OLD.merge_attempt_at IS DISTINCT FROM NEW.merge_attempt_at
        OR OLD.active_users_at_promote IS DISTINCT FROM NEW.active_users_at_promote
        OR OLD.approval_epoch IS DISTINCT FROM NEW.approval_epoch
        OR OLD.reviewed_head_sha IS DISTINCT FROM NEW.reviewed_head_sha
        OR OLD.boot_failure_sync_head IS DISTINCT FROM NEW.boot_failure_sync_head
        OR OLD.fixed_check_sync_head IS DISTINCT FROM NEW.fixed_check_sync_head
        OR OLD.fixed_check_sync_keys IS DISTINCT FROM NEW.fixed_check_sync_keys
        OR OLD.integration_resolved_epoch IS DISTINCT FROM NEW.integration_resolved_epoch)
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=proposal/session:',
    'status', 'promoted_at', 'archived_at', 'stale_notified_at', 'merge_attempt_at',
    'active_users_at_promote', 'approval_epoch', 'reviewed_head_sha',
    'boot_failure_sync_head', 'fixed_check_sync_head', 'fixed_check_sync_keys', 'integration_resolved_epoch');

-- campaign (src/workflow/campaign/) owns a fleet maintenance campaign once it
-- holds it: the campaign's status, when it ended, and each app's record (its
-- state and error), projected from the instance; and the lease columns an
-- older release's driver used, written by nothing now and dropped in a later
-- release. INSERTs are not guarded (the
-- governance apply inserts the campaign, the machine its app rows), nor are
-- the columns a foreign key empties (a deleted proposal, issue or author).
DROP TRIGGER IF EXISTS maintenance_campaigns_wf_owned ON maintenance_campaigns;
CREATE TRIGGER maintenance_campaigns_wf_owned
  BEFORE UPDATE ON maintenance_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=campaign/campaign:',
    'status', 'completed_at', 'runner_id', 'lease_until');
DROP TRIGGER IF EXISTS maintenance_campaign_apps_wf_owned ON maintenance_campaign_apps;
CREATE TRIGGER maintenance_campaign_apps_wf_owned
  BEFORE UPDATE ON maintenance_campaign_apps
  FOR EACH ROW
  WHEN (wf_holds('campaign', 'campaign:' || OLD.campaign_id))
  EXECUTE FUNCTION wf_guard_owned_columns('state', 'error', 'runner_id');

CREATE OR REPLACE FUNCTION wf_guard_shot_runs() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.wf_writer', true) = 'transition' THEN
    RETURN NEW;
  END IF;
  -- A deleted account's waiver (ON DELETE SET NULL) is not the run moving.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'override_user_id') = (to_jsonb(OLD) - 'override_user_id') THEN
    RETURN NEW;
  END IF;
  IF wf_holds('shots', 'session:' || NEW.session_id) THEN
    RAISE EXCEPTION 'WF_OWNERSHIP_VIOLATION: % on shot_runs of a proposal the shots machine holds', TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shot_runs_wf_shots_owned ON shot_runs;
CREATE TRIGGER shot_runs_wf_shots_owned
  BEFORE INSERT OR UPDATE ON shot_runs
  FOR EACH ROW EXECUTE FUNCTION wf_guard_shot_runs();

-- bot-request (src/workflow/bot-request/): the Homeroom bot's queue is its
-- projection. A row of a request it holds is written only by its
-- transitions; a row no instance holds yet (an older release's insert during
-- a rollout) is written as before and adopted (platform.adoptBotQueue). A
-- row going with its project (the cascade) or a deleted account's id
-- emptied (ON DELETE SET NULL) is not the queue moving.
CREATE OR REPLACE FUNCTION wf_guard_bot_queue() RETURNS TRIGGER AS $$
DECLARE
  r RECORD;
BEGIN
  IF current_setting('app.wf_writer', true) = 'transition' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  r := COALESCE(NEW, OLD);
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'requested_by' - 'payer_user_id') = (to_jsonb(OLD) - 'requested_by' - 'payer_user_id')
     AND (NEW.requested_by IS NULL OR NEW.requested_by IS NOT DISTINCT FROM OLD.requested_by)
     AND (NEW.payer_user_id IS NULL OR NEW.payer_user_id IS NOT DISTINCT FROM OLD.payer_user_id) THEN
    RETURN NEW;
  END IF;
  IF wf_holds('bot-request', 'request:' || r.app_id || ':' || r.issue_number) THEN
    RAISE EXCEPTION 'WF_OWNERSHIP_VIOLATION: % on homeroom_bot_queue of a request the bot-request machine holds', TG_OP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS homeroom_bot_queue_wf_owned ON homeroom_bot_queue;
CREATE TRIGGER homeroom_bot_queue_wf_owned
  BEFORE INSERT OR UPDATE OR DELETE ON homeroom_bot_queue
  FOR EACH ROW EXECUTE FUNCTION wf_guard_bot_queue();

-- A checks run's media (screenshots, recordings) while the run is under
-- way: its handler stores them here under the run's id, and the transition
-- that settles the run publishes them to session_visuals with its verdict,
-- in one transaction. A run that is cancelled or superseded never reaches
-- session_visuals; what it held goes when the session's next run settles,
-- or when its preview is retired. Same columns as session_visuals.
CREATE TABLE IF NOT EXISTS check_run_media (
  id                   VARCHAR(32) PRIMARY KEY,
  run_id               TEXT        NOT NULL,
  session_id           INTEGER     NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  commit_hash          VARCHAR(64),
  kind                 VARCHAR(8)  NOT NULL,
  media                VARCHAR(8)  NOT NULL,
  content_type         VARCHAR(32) NOT NULL,
  data                 BYTEA       NOT NULL,
  captured_path        VARCHAR(512),
  capture_index        SMALLINT    NOT NULL DEFAULT 0,
  captured_viewport    VARCHAR(16),
  shot_status          SMALLINT,
  before_fell_back     BOOLEAN     NOT NULL DEFAULT FALSE,
  scenario_id          VARCHAR(96),
  scenario_fingerprint VARCHAR(64),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS check_run_media_run_idx ON check_run_media (run_id);
CREATE INDEX IF NOT EXISTS check_run_media_session_idx ON check_run_media (session_id);
COMMENT ON TABLE check_run_media IS 'staging:private';

-- platform_live_at: a merge into Homeroom itself, when a production build
-- that carries it first started serving. Homeroom ships in a release cut
-- after the merge, so live_at (the merge, on the legacy paths) cannot say.
-- Stamped once, by the first production process to boot with it
-- (services/platform-release.js), and read by the Infra topic's Merge →
-- live (services/topic-figures.js). Nothing else reads it, so no "going
-- live" screen moves with it. Merges from before it was tracked stay NULL:
-- the marker below is when tracking began, so a first boot does not stamp
-- all of history with that boot's time.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_live_at TIMESTAMPTZ;
INSERT INTO platform_settings (key, value) VALUES
  ('platform_live_tracked_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- #4083: every account without access has a spot on the waitlist, however it
-- was made. Signups now get one as they are made (waitlist.ensureAccountSignup);
-- this gives the accounts already waiting without one theirs, once, guarded by
-- a marker like `onboarding_gate_grandfathered`. Only a confirmed address (the
-- account proved it), never an admin, a synthetic or a test account, and never
-- an account that already has a row: a phone row, or one holding the address.
-- In line from when the account was made; the token is the row's "Want in
-- sooner?" capability, two v4 UUIDs' worth of randomness.
INSERT INTO waitlist_signups (email, submitted_at, linked_user_id, confirmed_at, more_token)
  SELECT LOWER(u.email), COALESCE(u.created_at, NOW()), u.id,
         COALESCE(u.email_confirmed_at, NOW()),
         replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    FROM users u
   WHERE u.has_platform_access = FALSE
     AND u.is_admin IS NOT TRUE
     AND u.is_synthetic = FALSE
     AND u.test_account_created_at IS NULL
     AND u.email_confirmed = TRUE
     AND u.email IS NOT NULL AND u.email <> ''
     AND NOT EXISTS (SELECT 1 FROM waitlist_signups w WHERE w.linked_user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'waitlist_spots_backfilled')
ON CONFLICT DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
  ('waitlist_spots_backfilled', 'true',
    'Marker: the one-time backfill giving every waiting account a waitlist row (#4083) has run.')
ON CONFLICT (key) DO NOTHING;

-- Custom domains (#4405): a project served at a web address its manager
-- owns, beside its Homeroom address. One row per claim; the hostname is
-- proved by two DNS records (a CNAME to the app's Homeroom hostname and a
-- TXT `_homeroom.<hostname>` carrying the verification token), then the
-- edge issues a certificate and the gate routes the host to the app
-- (services/app-domains.js has the status machine). Private in staging: a
-- preview never serves a custom host, and the sweep never runs there.
CREATE TABLE IF NOT EXISTS app_domains (
  id                 SERIAL PRIMARY KEY,
  app_id             INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  hostname           VARCHAR(253) UNIQUE NOT NULL,
  verification_token CHAR(32) NOT NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'pending',
  dns_checked_at     TIMESTAMPTZ,
  verified_at        TIMESTAMPTZ,
  live_at            TIMESTAMPTZ,
  cert_expires_at    TIMESTAMPTZ,
  last_error         TEXT,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at        TIMESTAMPTZ,
  disabled_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE app_domains IS 'staging:private';
-- One custom domain per project in this version.
CREATE UNIQUE INDEX IF NOT EXISTS app_domains_one_per_app ON app_domains (app_id);
CREATE INDEX IF NOT EXISTS app_domains_status_idx ON app_domains (status);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_domains_status_check') THEN
    ALTER TABLE app_domains ADD CONSTRAINT app_domains_status_check
      CHECK (status IN ('pending', 'verified', 'live', 'failed', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_domains_hostname_check') THEN
    ALTER TABLE app_domains ADD CONSTRAINT app_domains_hostname_check
      CHECK (hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');
  END IF;
END $$;

-- #4490: a picture on every Needs-you card. `pr_diagram` is the change's
-- diagram as its author (submit_work `diagram`, a hosted build's
-- declare_diagram) sent it, validated by services/diagram.js: one of four
-- fixed kinds, or Mermaid source on a change declared as having nothing to
-- see. Data, never markup; Homeroom draws it. `pr_diagram_source` says who
-- supplied it ('author'). `pr_touches` is "What it touches", derived from the
-- files at `pr_touches_sha` by services/proposal-touches.js and refreshed when
-- the head moves.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_diagram JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_diagram_source TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_touches JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_touches_sha TEXT;
-- The durable build that owns the session ('bot-build/run:12',
-- 'bot-build/trial:7'; docs/plans/bot-build-workflow.md): its worker and its
-- turns are that build's to carry on after a restart, so server.js's worker
-- adoption leaves them alone while the build is under way.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS workflow_owner TEXT;
-- And the durable step that opened it ('session', 'build/session:triage'):
-- a restart between the insert and the step being saved finds the row
-- instead of opening a second session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS workflow_step TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_workflow_step
  ON chat_sessions (workflow_owner, workflow_step) WHERE workflow_owner IS NOT NULL;

-- Test release emails (services/test-accounts.js sendRelease, the connector's
-- send_test_release_email): a full admin sends the waitlist's real "you're
-- in" mail to an address they read, so the flow from that mail can be walked
-- in any environment, production included. Each row marks the
-- waitlist_signups row a send made: confirmed and released like an admitted
-- signup, and kept out of Admin → Waitlist and the Journey's admitted
-- cohorts. The NEW account that address makes is a test account
-- (waitlist.linkUserByEmail), marked before it is let in; retiring it deletes
-- the signup row and, by the cascade, this one. used_by is the test account
-- the release lets in. A release no account used is withdrawn, signup and
-- all, a week after its last send.
CREATE TABLE IF NOT EXISTS test_waitlist_releases (
  signup_id     BIGINT PRIMARY KEY REFERENCES waitlist_signups(id) ON DELETE CASCADE,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  welcome_dm    BOOLEAN NOT NULL DEFAULT FALSE,
  note          TEXT,
  used_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE test_waitlist_releases IS 'staging:private';

-- The Homeroom bot's voice outside its DM (services/homeroom-bot-voice.js):
-- one conversational agent answers in a change's discussion, a request's
-- discussion, a project's chat, its topics and reply threads, in its own
-- words, where it was asked. Code decides when it may speak; coding work
-- (reads, builds, updates to its changes) runs in sessions that report back
-- to it and never post.
--
-- One row per turn of it in one place, without the words (as
-- homeroom_bot_dm_turns): where (`place_type` is 'session', 'issue',
-- 'message', 'category' or 'chat'; `place_ref` its id or number, null for a
-- project's main chat; `place_key` both, as one claim), what started it
-- (`trigger` 'message' or 'job'), the newest message it read, how it ended
-- (`outcome` 'replied', 'quiet', 'fallback' or 'failed') and what it cost.
-- An unfinished row is the place's claim: one turn at a time per place,
-- across every process (the partial unique index); a claim left by a process
-- that died is taken back after a few minutes.
CREATE TABLE IF NOT EXISTS homeroom_bot_voice_turns (
  id                 SERIAL PRIMARY KEY,
  app_id             INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  place_type         TEXT NOT NULL,
  place_ref          INTEGER,
  place_key          TEXT NOT NULL,
  trigger            TEXT NOT NULL DEFAULT 'message',
  speaker_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  through_message_id INTEGER,
  reply_message_id   INTEGER,
  model              TEXT,
  rounds             INTEGER NOT NULL DEFAULT 0,
  tools              TEXT[] NOT NULL DEFAULT '{}',
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cost_usd           NUMERIC(12, 6),
  outcome            TEXT,
  error              TEXT,
  failures           TEXT[] NOT NULL DEFAULT '{}',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_voice_turns_running
  ON homeroom_bot_voice_turns(place_key) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_voice_turns_place
  ON homeroom_bot_voice_turns(place_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_voice_turns_started
  ON homeroom_bot_voice_turns(started_at DESC);
COMMENT ON TABLE homeroom_bot_voice_turns IS 'staging:private';

-- What people asked the bot to change on one of its own changes, wherever
-- they asked (the change's discussion, its request's, a project's chat, the
-- DM, a No vote's line), waiting for the follow-up that makes it. Talking
-- never waits for that work: the voice answers at once, and an ask made
-- while an update is running waits here, behind it, instead of being lost
-- to a queue row the running update holds. `status`: 'queued' (waiting),
-- 'taken' (the follow-up running now has it, `run_tag`), 'done', 'failed'
-- or 'dropped' (the change merged or closed first). `place_*` and
-- `message_id` are where it was asked, which is where the answer goes.
CREATE TABLE IF NOT EXISTS homeroom_bot_change_asks (
  id            SERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  issue_number  INTEGER NOT NULL,
  asker_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  instruction   TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'thread',
  place_type    TEXT,
  place_ref     INTEGER,
  message_id    INTEGER,
  status        TEXT NOT NULL DEFAULT 'queued',
  run_tag       TEXT,
  tries         INTEGER NOT NULL DEFAULT 0,
  run_id        INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taken_at      TIMESTAMPTZ,
  done_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_change_asks_session
  ON homeroom_bot_change_asks(session_id, status, id);
-- A message passed on as an ask is not the voice's to answer as well.
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_change_asks_message
  ON homeroom_bot_change_asks(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_change_asks_run_tag
  ON homeroom_bot_change_asks(run_tag) WHERE run_tag IS NOT NULL;
COMMENT ON TABLE homeroom_bot_change_asks IS 'staging:private';

-- Something the voice offered to do in a thread, done only when the right
-- person taps it under its message (as homeroom_bot_dm_actions in the DM):
-- file a request ('file_request', for whoever asked), withdraw one of its
-- changes ('withdraw_change', for its requester or the project's owner), or
-- open a vote on closing a request ('close_request'). `args` is what the
-- offer needs; `result` what the tap did.
CREATE TABLE IF NOT EXISTS homeroom_bot_voice_offers (
  id            SERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  message_id    INTEGER UNIQUE,
  kind          TEXT NOT NULL,
  args          JSONB NOT NULL DEFAULT '{}'::jsonb,
  for_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'open',
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_voice_offers_app
  ON homeroom_bot_voice_offers(app_id, status, id);
COMMENT ON TABLE homeroom_bot_voice_offers IS 'staging:private';

-- The translation cache (src/services/language-cache.js): every translation
-- the translation step accepted, kept by the English it was translated from.
-- `source` is the sha256 of that English message, as a committed catalog
-- entry's `source` is, so a message is translated once per wording: a deploy
-- reads what is here, and only a message whose English is new or changed is
-- translated again. Committed catalog entries (frontend/locales) still win:
-- a person correcting a translation commits it with "locked": true. Public:
-- it is the shell's own text, the same in every environment.
CREATE TABLE IF NOT EXISTS language_translations (
  language    VARCHAR(35) NOT NULL,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  source      CHAR(64) NOT NULL,
  text        TEXT NOT NULL,
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (language, namespace, key, source)
);

-- Newcomer test runs (services/run-report.js): what was recorded about each
-- project a test account made, its first version above all (the plan at
-- Make it, the bot's runs and review rounds, its sessions, agent turns and
-- their telemetry, helper model calls, screens without their images, and
-- incidents), kept when the account is retired (services/test-accounts.js
-- retire). Taking the app down deletes its first version, runs, sessions,
-- turns and screens with it (ON DELETE CASCADE), so the report is built and
-- kept first; the connector's get_run_report reads it once the app is gone.
-- One row per app (`app_id_was`, no foreign key: the app is gone): a retire
-- run again after a teardown failed replaces it with the fresher report.
-- `slug`, `app_name` and `test_username` are as they were when it was kept;
-- the account's own username changes when it is deleted. Private: the
-- report quotes review issues about a private project's screens and the
-- answers its maker chose, as homeroom_bot_runs.review and
-- homeroom_bot_first_versions are.
CREATE TABLE IF NOT EXISTS test_run_reports (
  id             BIGSERIAL PRIMARY KEY,
  app_id_was     INTEGER NOT NULL UNIQUE,
  slug           VARCHAR(255) NOT NULL,
  app_name       TEXT,
  test_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  test_username  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_run_reports_slug
  ON test_run_reports (slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_run_reports_user
  ON test_run_reports (test_user_id, created_at DESC);
COMMENT ON TABLE test_run_reports IS 'staging:private';

-- Private requests (#5048): requests only platform admins can see, for
-- security and confidential work. Every other request is a GitHub issue, and
-- the platform's repository is public, so a private request is never filed
-- there: it lives in these two tables alone and is read and written only
-- through routes/private-requests.js, which answers 404 to anyone who is not
-- a platform admin. `status` is 'open' or 'closed'. Private, so a staging
-- copy gets the tables without the rows (seedStagingPrivateRequest writes the
-- one demo row there).
CREATE TABLE IF NOT EXISTS private_requests (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'open',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_private_requests_app
  ON private_requests (app_id, status, created_at DESC);
COMMENT ON TABLE private_requests IS 'staging:private';

-- Its discussion: a comment list, not a chat thread, because chat threads
-- are read by every viewer of the app and fanned out to its whole room.
CREATE TABLE IF NOT EXISTS private_request_comments (
  id                 SERIAL PRIMARY KEY,
  private_request_id INTEGER NOT NULL REFERENCES private_requests(id) ON DELETE CASCADE,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_private_request_comments_request
  ON private_request_comments (private_request_id, id);
COMMENT ON TABLE private_request_comments IS 'staging:private';

-- When each of the leader's long-interval sweeps last completed
-- (services/leader-timers.js, a `durable` timer). The leader changes with
-- every release, about every twenty minutes on a busy day, and an hourly
-- setInterval restarts its clock at each election, so the stale-proposal
-- sweep, the Workshop theme sweep and the grant prune went days without
-- running. On election each one now runs when this says it is due. One row
-- per sweep, written by the leader after each completed run; a sweep with
-- no row has never run and is due at once. Nothing private: names and
-- times.
CREATE TABLE IF NOT EXISTS leader_sweeps (
  name        TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL
);

-- The platform's processes, and what each one is doing that no other may
-- adopt, tear down, duplicate or call idle (services/processes.js,
-- docs/plans/draining-releases.md). A release no longer cuts the Pod it
-- replaces: that Pod finishes its work while the new one serves, so two
-- processes run live work at once and each must see the other's. A process
-- writes its row at boot, beats it every 10 seconds, marks it `draining`
-- (with its deadline) as shutdown begins and deletes it as it exits; one
-- whose beat is older than 45 seconds is gone, whatever the row says, and the
-- leader deletes such rows (holds go with them). Private to staging clones:
-- a preview copying production's rows would believe production's work its
-- own, live.
CREATE TABLE IF NOT EXISTS platform_processes (
  id                TEXT PRIMARY KEY,
  release           TEXT,
  role              TEXT NOT NULL DEFAULT 'all',
  host              TEXT,
  ip                TEXT,
  state             TEXT NOT NULL DEFAULT 'serving',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drain_started_at  TIMESTAMPTZ,
  drain_deadline_at TIMESTAMPTZ,
  CONSTRAINT platform_processes_state_check CHECK (state IN ('serving', 'draining'))
);
CREATE INDEX IF NOT EXISTS idx_platform_processes_heartbeat ON platform_processes (heartbeat_at);
COMMENT ON TABLE platform_processes IS 'staging:private';

-- One row per thing a process holds: `kind` (a session's turn, a preview
-- build, a shots run, ...; processes.js KINDS) for `ref` (its id). Written
-- on the process's first hold of it and removed on its last release, and the
-- whole set written again with every beat.
CREATE TABLE IF NOT EXISTS process_holds (
  process_id TEXT NOT NULL REFERENCES platform_processes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  since      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (process_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_process_holds_ref ON process_holds (kind, ref);
COMMENT ON TABLE process_holds IS 'staging:private';

-- The read-only database roles the leader sets up at its election
-- (services/debug-access.js usernode_debug_ro, topochain/db-console-role.js
-- topochain_console_ro), as every other process reads them: a web process
-- never leads (docs/plans/web-and-conductor.md), and answers the prod-debug
-- and SQL console routes with what the leader made. `ok` is whether its last
-- setup succeeded. `secret_enc` is a LOGIN role's password, encrypted with
-- the data key (services/secrets.js), as app secrets are; a NOLOGIN role has
-- none. The prod-debug role may not read this table (its deny list says
-- so), the SQL console masks `secret_enc`, and a staging copy gets no rows.
CREATE TABLE IF NOT EXISTS platform_db_roles (
  role       TEXT PRIMARY KEY,
  ok         BOOLEAN NOT NULL,
  reason     TEXT,
  secret_enc TEXT,
  release    TEXT,
  ensured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE platform_db_roles IS 'staging:private';

-- What the leader keeps in memory and an admin screen reads, written by the
-- leader for the processes that do not lead (services/leader-status.js,
-- docs/plans/web-and-conductor.md): the bench lane, the domain sweep, the
-- preview reaper, ... One row per status, rewritten every few seconds while
-- its leader leads; a row nobody rewrote for two minutes is read as none.
CREATE TABLE IF NOT EXISTS leader_status (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  process_id   TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE leader_status IS 'staging:private';

-- Before & after shots EVALS (services/shots-eval.js, its runner in
-- services/shots-eval-runner.js): an admin trying the shots agent with
-- another model, prompt or time budget on proposals that have already
-- merged, through the connector, and comparing what it saves with what the
-- live shots agent saves on the same proposals in the same batch. Nothing
-- here touches a proposal's own shots: a trial is never its proposal's
-- shots run, its files live in shots_eval_artifacts, and it is billed to the
-- platform, never to the proposal's author.
--
-- A CONFIGURATION is one immutable version of a recipe: the shots agent's
-- model, its system prompt (whole, or null for the live one), guidance
-- added after it, its task prompt, and its time budget. Saving again under
-- the same key makes the next version. Not private: admin-written recipes,
-- nothing about anybody's app.
CREATE TABLE IF NOT EXISTS shots_eval_configs (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  label       TEXT NOT NULL,
  recipe      JSONB NOT NULL,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shots_eval_configs_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  CONSTRAINT shots_eval_configs_version_check CHECK (version > 0),
  UNIQUE (key, version)
);

-- One EVAL: a batch of merged proposals, each shot by the live agent (the
-- control) and by each named configuration, `repeats` times, until it is
-- done, cancelled or reaches its cap. `config_ids` are the configurations
-- beside the control, in the order they were named. `spent_cents` is what
-- its finished trials cost; the cap stops new trials, and the ones already
-- running finish. Private, with its trials.
CREATE TABLE IF NOT EXISTS shots_eval_runs (
  id           SERIAL PRIMARY KEY,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  config_ids   INTEGER[] NOT NULL DEFAULT '{}',
  repeats      INTEGER NOT NULL DEFAULT 1,
  cap_cents    INTEGER NOT NULL,
  est_cents    INTEGER NOT NULL DEFAULT 0,
  spent_cents  NUMERIC(12,4) NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  CONSTRAINT shots_eval_runs_status_check CHECK (status IN ('running', 'done', 'cancelled', 'capped')),
  CONSTRAINT shots_eval_runs_repeats_check CHECK (repeats BETWEEN 1 AND 3),
  CONSTRAINT shots_eval_runs_cap_check CHECK (cap_cents > 0)
);
CREATE INDEX IF NOT EXISTS idx_shots_eval_runs_running ON shots_eval_runs(id) WHERE status = 'running';
COMMENT ON TABLE shots_eval_runs IS 'staging:private';

-- One TRIAL: one proposal shot once by one arm (`config_id`, null for the
-- live control). The proposal's revisions and declared changes are frozen
-- at launch, from its own published run, so every arm shoots the same
-- thing. `attempt_id` names this attempt's copies, databases and control
-- plane the way a shots run's id does (shots-environment.js); a trial a
-- restart interrupted gets a fresh one and runs again, at most twice.
-- `state` follows a shots run's (shots-state.js): planned, provisioning,
-- exploring, reviewing, then verified or failed; or cancelled. `recipe` is
-- what it ran with (the model, the prompts' hashes and lengths, the
-- budget), `hard_verdict` how each declared change came out, and
-- `trace_summary` the run's timings, tool counts and the agent's last words.
-- Private: a proposal's declared changes and the agent's words about an
-- app's screens.
CREATE TABLE IF NOT EXISTS shots_eval_trials (
  id              SERIAL PRIMARY KEY,
  eval_run_id     INTEGER NOT NULL REFERENCES shots_eval_runs(id) ON DELETE CASCADE,
  session_id      INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  config_id       INTEGER REFERENCES shots_eval_configs(id) ON DELETE CASCADE,
  repetition      INTEGER NOT NULL DEFAULT 1,
  position        INTEGER NOT NULL,
  attempt_id      VARCHAR(32) NOT NULL UNIQUE CHECK (attempt_id ~ '^[0-9a-f]{32}$'),
  attempts        INTEGER NOT NULL DEFAULT 0,
  base_sha        VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha        VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  intent          JSONB NOT NULL,
  state           TEXT NOT NULL DEFAULT 'planned',
  recipe          JSONB,
  hard_verdict    JSONB,
  plan_hash       VARCHAR(64),
  trace_summary   JSONB,
  failure_code    TEXT,
  failure_reason  TEXT,
  cost_cents      NUMERIC(12,4) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT shots_eval_trials_state_check
    CHECK (state IN ('planned', 'provisioning', 'exploring', 'reviewing', 'verified', 'failed', 'cancelled')),
  CONSTRAINT shots_eval_trials_repetition_check CHECK (repetition BETWEEN 1 AND 3)
);
-- What the Anthropic proxy billed for the trial on a process other than the
-- one running it (services/shots-eval-runner.js noteRemoteSpend): during a
-- release the runner may finish a trial on a Pod the Service no longer sends
-- its shots agent's calls to. Settled into cost_cents with the rest.
ALTER TABLE shots_eval_trials ADD COLUMN IF NOT EXISTS proxy_cents NUMERIC(12,4) NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shots_eval_trials_arm
  ON shots_eval_trials (eval_run_id, session_id, COALESCE(config_id, 0), repetition);
CREATE INDEX IF NOT EXISTS idx_shots_eval_trials_planned
  ON shots_eval_trials (eval_run_id, position) WHERE state = 'planned';
CREATE INDEX IF NOT EXISTS idx_shots_eval_trials_active
  ON shots_eval_trials (session_id) WHERE state IN ('provisioning', 'exploring', 'reviewing');
COMMENT ON TABLE shots_eval_trials IS 'staging:private';

-- What a trial saved, stored the way a shots run's files are
-- (shot_artifacts): one row per file, gone with the trial. Read only
-- through the admin connector. The images themselves are pruned after
-- shots-gc.js EVAL_ARTIFACT_DAYS; the trial keeps its results. Private: an
-- app's screens can show any of its data.
CREATE TABLE IF NOT EXISTS shots_eval_artifacts (
  id            VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  trial_id      INTEGER NOT NULL REFERENCES shots_eval_trials(id) ON DELETE CASCADE,
  story_id      VARCHAR(96) NOT NULL,
  viewport      VARCHAR(32) NOT NULL,
  side          VARCHAR(8) NOT NULL CHECK (side IN ('base', 'head')),
  variant       VARCHAR(16) NOT NULL CHECK (variant IN ('focus', 'context', 'animation')),
  media         VARCHAR(8) NOT NULL CHECK (media IN ('png', 'webm', 'gif')),
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA NOT NULL,
  width         INTEGER CHECK (width IS NULL OR width > 0),
  height        INTEGER CHECK (height IS NULL OR height > 0),
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  sha256        VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  focus_rect    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (trial_id, story_id, viewport, side, variant, media)
);
COMMENT ON TABLE shots_eval_artifacts IS 'staging:private';

-- A blind PAIR: the control's trial and one configuration's, of the same
-- proposal and repetition, for an admin's pick through the connector (left,
-- right or a tie), with what they marked about each side's ready changes
-- (`marks`: does each show its claim, and is any misleading). The sides are
-- drawn at random when the pair is made (`left_is_control`, never shown);
-- `token` is the only id a picker sees. A pair is `excluded`, with why,
-- when the platform failed either side or neither has a ready change.
CREATE TABLE IF NOT EXISTS shots_eval_pairs (
  id                SERIAL PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,
  eval_run_id       INTEGER NOT NULL REFERENCES shots_eval_runs(id) ON DELETE CASCADE,
  control_trial_id  INTEGER NOT NULL REFERENCES shots_eval_trials(id) ON DELETE CASCADE,
  arm_trial_id      INTEGER NOT NULL REFERENCES shots_eval_trials(id) ON DELETE CASCADE,
  left_is_control   BOOLEAN NOT NULL,
  status            TEXT NOT NULL DEFAULT 'waiting',
  excluded_reason   TEXT,
  pick              TEXT,
  marks             JSONB,
  note              TEXT,
  picked_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shots_eval_pairs_status_check CHECK (status IN ('waiting', 'excluded', 'picked')),
  CONSTRAINT shots_eval_pairs_pick_check CHECK (pick IS NULL OR pick IN ('control', 'arm', 'tie')),
  UNIQUE (control_trial_id, arm_trial_id)
);
CREATE INDEX IF NOT EXISTS idx_shots_eval_pairs_waiting ON shots_eval_pairs(eval_run_id, id) WHERE status = 'waiting';
COMMENT ON TABLE shots_eval_pairs IS 'staging:private';

-- #3228: the short note an inviter writes when creating a group or adding
-- people, shown only on the invited person's invitation card until they
-- answer it. Nullable: most invitations carry none.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS invite_note TEXT;

-- A phone icon owed a re-badge: a workflow transition that told somebody
-- their bell changed (a `notifications_changed` push) writes this row in its
-- own transaction (src/workflow/platform.ts publishPushes), and the mobile
-- push worker drains it, recounting the unread total and sending a
-- badge-only push to each of their iOS registrations
-- (services/mobile-push-worker.js drainBadges). One row per person:
-- `queued_at` moves on a newer change, so a burst settles into one push.
-- `claimed_until`: the worker taking it; a row whose claim lapsed (the
-- worker's process ended) is taken again.
CREATE TABLE IF NOT EXISTS mobile_push_badge_syncs (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_until  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mobile_push_badge_syncs_due ON mobile_push_badge_syncs(queued_at);
COMMENT ON TABLE mobile_push_badge_syncs IS 'staging:private';

-- ── The bot's replies and hellos, on workflow machines ────────────────────
-- (docs/workflows.md bot-voice, bot-dm.) What a person writes to the bot is
-- an event in the transaction that stores it; the answer, a tap's act and
-- a hello are work, keyed so a retry says and does nothing twice.
--
-- A tap's act (homeroom-bot-mayor.js settleOffer, homeroom-bot-dm.js
-- decidePlanTap, homeroom-bot-voice.js actOnOffer) decides its offer once,
-- first come first served, by moving it out of 'open'. `decided_key` is the
-- work item that did: a retry of that same item after a restart passes its
-- own claim and carries the act on, where a claim written before the act
-- used to leave "already decided" with nothing done.
ALTER TABLE homeroom_bot_dm_actions ADD COLUMN IF NOT EXISTS decided_key TEXT;
ALTER TABLE homeroom_bot_voice_offers ADD COLUMN IF NOT EXISTS decided_key TEXT;
-- A voice turn's work item (bot-voice's `turn:<n>`, with its place): the
-- turn's record row is that item's, so a retry after a restart takes its own
-- row up again instead of waiting out a claim it left.
ALTER TABLE homeroom_bot_voice_turns ADD COLUMN IF NOT EXISTS turn_key TEXT;
-- One ask per change and message: a turn asked again after a restart (its
-- work item retried) records the words it already recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_change_asks_once
  ON homeroom_bot_change_asks(session_id, message_id) WHERE message_id IS NOT NULL;
-- The newcomer's offer: one row per model read of a newcomer's message
-- (homeroom-bot-chat.js maybeOffer), so its budget (per person a day, and
-- for everybody an hour) holds across processes and restarts.
CREATE TABLE IF NOT EXISTS homeroom_bot_offer_reads (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  INTEGER NOT NULL,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id)
);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_offer_reads_user ON homeroom_bot_offer_reads(user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_homeroom_bot_offer_reads_at ON homeroom_bot_offer_reads(read_at DESC);
COMMENT ON TABLE homeroom_bot_offer_reads IS 'staging:private';

-- ── Pinned communities: the desktop sidebar's Pinned section ──────────
--
-- The communities a person pinned to the desktop sidebar
-- (frontend/src/features/nav/rail-pinned.tsx), above the five they opened
-- last, in the order they pinned them. A pin is the account's, so it
-- follows them to another computer. Until 18 Oct 2026 the sidebar's pins
-- were apps kept on each device; a device moves the ones it kept up once
-- (services/community-pins.js importPins).
--
-- ONLY A MEMBER'S. The key is the membership row's, so a pin exists only
-- for a community you are in, and leaving it (communities.leave, or any
-- other path that deletes the membership) takes the pin with it. Four at
-- most, which the service enforces.
--
-- Not staging:private: it says only which of their own communities a
-- person keeps at hand, and community_members already says they are in it.
CREATE TABLE IF NOT EXISTS community_pins (
  community_id INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  pinned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, community_id),
  FOREIGN KEY (community_id, user_id) REFERENCES community_members (community_id, user_id) ON DELETE CASCADE
);

-- ── Platform signals: problems the platform found in itself ─────────────
--
-- One row per EPISODE of a problem the platform detected on its own (a
-- release that stalled, a workflow instance that faulted, an infra alert):
-- services/platform-signals.js. A problem is its `fingerprint` (its kind
-- and the narrowest stable thing it is about, e.g. "release_stalled:
-- workflow_failed"), and has at most one row that is not closed, which is
-- the claim: two pods, or a retry after a crash, file once. Each row files
-- (or, in shadow mode, only records) one request on the board of `app_id`,
-- counts recurrences here rather than on GitHub, and closes once the
-- problem has stayed clear for its kind's quiet window.
--
--   state      pending   seen, not filed yet (waiting out its kind's delay,
--                        a release, the hourly cap or GitHub's budget)
--              open      filed (issue_number), or recorded in shadow mode
--              clearing  the detector says it stopped; waiting to be sure
--              closed    done; a later raise starts a new row, which
--                        reopens this one's request within 7 days
--   fixer      bot | person | infra: who is expected to fix it. Only a
--              `bot` row is put in the Homeroom bot's queue; the others
--              hold it off (homeroom-bot.js issueHolders).
--   evidence   the PUBLIC tier: what the request's body says. The platform
--              repository is public, so it is scrubbed and typed facts only.
--   evidence_private  the private tier, for full admins: raw lines, ids.
CREATE TABLE IF NOT EXISTS platform_signals (
  id                    BIGSERIAL PRIMARY KEY,
  fingerprint           TEXT NOT NULL,
  kind                  VARCHAR(48) NOT NULL,
  subject               JSONB NOT NULL DEFAULT '{}'::jsonb,
  app_id                INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  topic_key             VARCHAR(64),
  fixer                 VARCHAR(8) NOT NULL DEFAULT 'bot'
                          CHECK (fixer IN ('bot', 'person', 'infra')),
  state                 VARCHAR(12) NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'open', 'clearing', 'closed')),
  title                 TEXT,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrences           INTEGER NOT NULL DEFAULT 1,
  published_occurrences INTEGER,
  cleared_at            TIMESTAMPTZ,
  filed_at              TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  close_reason          VARCHAR(24),
  issue_number          INTEGER,
  muted_until           TIMESTAMPTZ,
  evidence              JSONB,
  evidence_private      JSONB,
  evidence_at           TIMESTAMPTZ,
  previous_id           BIGINT REFERENCES platform_signals(id) ON DELETE SET NULL,
  filing_attempts       INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_signals_one_open
  ON platform_signals (fingerprint) WHERE state <> 'closed';
CREATE INDEX IF NOT EXISTS idx_platform_signals_topic
  ON platform_signals (topic_key, state);
CREATE INDEX IF NOT EXISTS idx_platform_signals_issue
  ON platform_signals (app_id, issue_number) WHERE issue_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_signals_kind_seen
  ON platform_signals (kind, last_seen_at DESC);
COMMENT ON COLUMN platform_signals.evidence_private IS 'staging:private';

-- When a source that only speaks while it is alive last spoke: the
-- Alertmanager receiver's Watchdog heartbeat (routes/alerts-webhook.js).
-- Two hours without one raises `alerting_silent`; a source never heard
-- from (no row) raises nothing, so an unconfigured receiver stays quiet.
CREATE TABLE IF NOT EXISTS platform_signal_sources (
  source        VARCHAR(48) PRIMARY KEY,
  last_heard_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Server errors, counted (platform signals, wave 2) ──────────────────
--
-- A 5xx was a log line and one process's 200-line buffer, so a route that
-- failed one request in ten for a day was seen only by somebody reading
-- logs. Each process counts what it answered, per minute, and flushes the
-- counts here (services/server-error-counts.js): every /api/ response in
-- server_request_minutes, and each 5xx by its route TEMPLATE (never the raw
-- path), error type and first frame in this repository in
-- server_error_minutes. The `infra.server-errors` figure reads the first;
-- the `server_errors` signal (services/signal-observers/server-errors.js)
-- reads the second. `sample` is one scrubbed message, for full admins only.
-- Rows older than 14 days are pruned by the flusher.
CREATE TABLE IF NOT EXISTS server_request_minutes (
  minute    TIMESTAMPTZ NOT NULL,
  pod       VARCHAR(64) NOT NULL,
  requests  INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, pod)
);
CREATE TABLE IF NOT EXISTS server_error_minutes (
  minute    TIMESTAMPTZ NOT NULL,
  pod       VARCHAR(64) NOT NULL,
  method    VARCHAR(8) NOT NULL,
  route     VARCHAR(160) NOT NULL,
  status    SMALLINT NOT NULL,
  err_type  VARCHAR(64) NOT NULL DEFAULT '',
  frame     VARCHAR(160) NOT NULL DEFAULT '',
  count     INTEGER NOT NULL DEFAULT 0,
  sample    TEXT,
  PRIMARY KEY (minute, pod, method, route, status, err_type, frame)
);
CREATE INDEX IF NOT EXISTS idx_server_error_minutes_minute ON server_error_minutes (minute DESC);
COMMENT ON COLUMN server_error_minutes.sample IS 'staging:private';

-- ── Who can reach you, and who can find you (#5104) ───────────────────
--
-- Teen-safe defaults for everyone, existing accounts included (ADD COLUMN
-- with a DEFAULT fills every row that is already there). A person loosens
-- either in Settings › Privacy (sections/privacy.tsx, POST
-- /api/me/contact-privacy); nothing else writes them.
--
--   contact_policy  who may START something with you: a new direct message,
--                   an invitation to a group chat, a project or its
--                   approvers, and a friend request. 'shared' (the default)
--                   is people you are connected to (users_connected below);
--                   'anyone' is what everybody had before. A conversation
--                   that already exists keeps working either way: the rule
--                   is read only when something new is started.
--   profile_discoverable  whether people you are not connected to find your
--                   username in a search: the people pickers, the invite
--                   typeahead, an app's searchUsers, and the @ list of a
--                   channel everyone reads (#general). Off by default. Your
--                   profile page is a separate, older opt-in
--                   (profile_published) and is not changed by this.
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_policy VARCHAR(16) NOT NULL DEFAULT 'shared';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_discoverable BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_contact_policy_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_contact_policy_check
      CHECK (contact_policy IN ('shared', 'anyone'));
  END IF;
END $$;

-- The projects `u` is in BY CONSENT on both sides, the ties users_connected
-- below counts:
--
--   - a project they created (apps.created_by);
--   - a project they joined by accepting an invitation or redeeming an
--     invite link (app_collaborators.accepted_via, set only by those two
--     paths), from somebody who is in it by consent themselves: its creator,
--     or a member whose own row has accepted_via. That check is one level
--     deep, not recursive.
--
-- Nothing else counts. A member row nobody accepted (dapp.json's declared
-- admins, which applyAdminsChange seeds without asking, even over a pending
-- invite) has no accepted_via. app_admins alone never counts. Community
-- membership never counts on its own: Join, a Home pin, a vote or activity
-- is self-service, and an invite link into a community that is not public
-- always writes a collaborator row (apps_visibility_combo_check: a project
-- only its people can see is one only its people build), which the second
-- rule reads with its maker. Homeroom's own project is never one.
CREATE OR REPLACE FUNCTION user_consented_projects(u INTEGER)
RETURNS SETOF INTEGER
LANGUAGE sql STABLE AS $$
  SELECT pa.id FROM apps pa
   WHERE pa.created_by = u AND NOT pa.self_hosted
  UNION
  SELECT c.app_id FROM app_collaborators c
    JOIN apps pa ON pa.id = c.app_id
   WHERE c.user_id = u AND c.status = 'member'
     AND c.accepted_via IS NOT NULL
     AND c.invited_by IS NOT NULL AND c.invited_by <> u
     AND NOT pa.self_hosted
     AND (pa.created_by = c.invited_by
          OR EXISTS (SELECT 1 FROM app_collaborators mk
                      WHERE mk.app_id = c.app_id AND mk.user_id = c.invited_by
                        AND mk.status = 'member' AND mk.accepted_via IS NOT NULL))
$$;

-- Two people are CONNECTED only by a tie neither of them can make alone: an
-- accepted friendship, or a project both are in by consent
-- (user_consented_projects above). Sharing a public community, or being
-- named somewhere without being asked, connects nobody.
CREATE OR REPLACE FUNCTION users_connected(a INTEGER, b INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
           SELECT 1 FROM friendships f
            WHERE f.status = 'accepted'
              AND f.user_low_id = LEAST(a, b) AND f.user_high_id = GREATEST(a, b))
      OR EXISTS (
           SELECT 1
             FROM user_consented_projects(a) pa(app_id)
             JOIN user_consented_projects(b) pb(app_id) ON pb.app_id = pa.app_id)
$$;

-- Whether `sender_id` may start something new with `target_id` (see
-- contact_policy above). A platform account (the Homeroom bot) on either
-- side is never held to it: it cannot be a stranger, and a person can always
-- write to it.
CREATE OR REPLACE FUNCTION user_contactable_by(target_id INTEGER, sender_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT target_id = sender_id
      OR EXISTS (SELECT 1 FROM users t WHERE t.id = target_id
                    AND (t.contact_policy = 'anyone' OR t.is_synthetic))
      OR EXISTS (SELECT 1 FROM users s WHERE s.id = sender_id AND s.is_synthetic)
      OR users_connected(target_id, sender_id)
$$;

-- Whether `viewer_id` may find `target_id` in a search (profile_discoverable
-- above). Yourself, and people you are connected to, always.
CREATE OR REPLACE FUNCTION user_discoverable_by(target_id INTEGER, viewer_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT target_id = viewer_id
      OR EXISTS (SELECT 1 FROM users t WHERE t.id = target_id AND t.profile_discoverable)
      OR (viewer_id IS NOT NULL AND users_connected(target_id, viewer_id))
$$;
