-- Homeroom bot parity, P6 and P7.
--
-- P6: red checks that are not the change's. When the fix turn on one of the
-- bot's changes finds a failing check fails without the change too, the bot
-- does what a person would (homeroom-bot-flaky-checks.js): brings the change
-- up to date with main once, then finds or files a request for the check on
-- Homeroom's own board ("Flaky check: <test>"), has itself build that fix
-- outside its project's five slots, and runs the waiting changes' checks
-- again once the fix merges. Only then is a person asked.

-- One fix per failing check: the request it lives in (found or filed) and
-- how far it got. At most one open row per check (`test_key`), and at most
-- MAX_IN_FLIGHT 'building' across the platform; the rest wait their turn.
-- `building` is the narrow exemption from PROPOSALS_PER_APP_CAP
-- (homeroom-bot.js simulateCaps reads it for that request alone).
CREATE TABLE IF NOT EXISTS homeroom_bot_flake_fixes (
  id                SERIAL PRIMARY KEY,
  test_key          TEXT NOT NULL,
  test_name         TEXT NOT NULL,
  test_file         TEXT,
  app_id            INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number      INTEGER NOT NULL CHECK (issue_number > 0),
  filed             BOOLEAN NOT NULL DEFAULT FALSE,
  state             VARCHAR(16) NOT NULL DEFAULT 'waiting'
                    CHECK (state IN ('waiting', 'building', 'merged', 'failed', 'closed', 'expired')),
  merged_session_id INTEGER,
  why               TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_flake_fixes_open_test
  ON homeroom_bot_flake_fixes (test_key) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS homeroom_bot_flake_fixes_open_request
  ON homeroom_bot_flake_fixes (app_id, issue_number) WHERE ended_at IS NULL;

-- A change of the bot's on its way past a failure that is not its own: where
-- it is on the ladder (`stage`: synced, fixing, rechecking, then green or
-- person), the checks it failed, the fixes it waits on, and the card in its
-- requester's chat with the bot that follows it (homeroom-bot-cards
-- checks_green, patched as it moves).
CREATE TABLE IF NOT EXISTS homeroom_bot_flake_waits (
  session_id      INTEGER PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number    INTEGER,
  stage           VARCHAR(16) NOT NULL
                  CHECK (stage IN ('synced', 'fixing', 'rechecking', 'green', 'person')),
  synced          BOOLEAN NOT NULL DEFAULT FALSE,
  flake_ids       INTEGER[] NOT NULL DEFAULT '{}',
  tests           JSONB NOT NULL DEFAULT '[]'::jsonb,
  head_sha        TEXT,
  why             TEXT,
  card_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  card_message_id INTEGER,
  rechecked_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS homeroom_bot_flake_waits_open
  ON homeroom_bot_flake_waits (stage) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS homeroom_bot_flake_waits_flakes
  ON homeroom_bot_flake_waits USING GIN (flake_ids) WHERE ended_at IS NULL;

-- P7: admin tools in an admin's conversations with the bot. Its turn reaches
-- the connector's own admin tools through the in-process MCP shim on a
-- delegated grant of their own kind (services/mcp-audiences.js bot_admin).
ALTER TABLE mcp_delegations DROP CONSTRAINT IF EXISTS mcp_delegations_kind_check;
ALTER TABLE mcp_delegations ADD CONSTRAINT mcp_delegations_kind_check
  CHECK (kind IN ('agent_mayor', 'worker_read', 'bot_admin'));

-- A write an admin's turn prepared and nobody has confirmed yet: the exact
-- input sealed (services/confirmations), shown on a confirm card under the
-- reply, run once by the admin's Confirm tap on a one-action write grant
-- (homeroom-bot-thread-tools/admin.js, homeroom-bot-cards/confirm.js).
-- pending → running → done | failed, or pending → dismissed. Expiry is read
-- from expires_at, so nothing has to sweep it.
CREATE TABLE IF NOT EXISTS homeroom_bot_admin_actions (
  id              UUID PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_root_id  INTEGER,
  tool_name       VARCHAR(64) NOT NULL,
  sealed_input    JSONB NOT NULL,
  input_hash      VARCHAR(64) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  result          JSONB,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_admin_actions_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'dismissed')),
  CONSTRAINT homeroom_bot_admin_actions_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT homeroom_bot_admin_actions_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS homeroom_bot_admin_actions_user
  ON homeroom_bot_admin_actions (user_id, created_at DESC);
COMMENT ON TABLE homeroom_bot_admin_actions IS 'staging:private';
