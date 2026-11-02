-- Homeroom bot parity, P3 and P9: the bot sends a helper to read a
-- project's code (look_into), and runs an investigation for days, each
-- check-in one such look (start_investigation).

-- The session a person's looks into one project run in: the bot's own, on
-- main, apart from the project's triage session (homeroom-bot.js
-- ensureBotSession, rules/bot-loop.ts leave these out), so a look never
-- takes the session a read of a request is granted.
CREATE TABLE IF NOT EXISTS homeroom_bot_look_sessions (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_look_sessions_session_idx ON homeroom_bot_look_sessions (session_id);
COMMENT ON TABLE homeroom_bot_look_sessions IS 'staging:private';

-- An investigation (homeroom-bot-thread-tools/investigate.js): a goal on
-- one project, checked on every `every_hours` for up to `days`, within its
-- own budget, its notes kept from one check-in to the next. Proposed by the
-- bot as a card; nothing runs or spends until its owner taps Start, and from
-- then the bot-investigation machine owns it (src/workflow/bot-investigation/:
-- state, spent_cents, next_at, ended_*). `checkins` and `notes` are written
-- by its check-ins' work, once per check-in.
CREATE TABLE IF NOT EXISTS homeroom_bot_investigations (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id            INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id   INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  -- The person's message the bot proposed it in answer to (a retry of that
  -- answer proposes nothing twice), the thread it is in, and the bot's
  -- reply that carries its card (set when they tap Start).
  source_message_id INTEGER,
  thread_root_id    INTEGER,
  card_message_id   INTEGER,
  goal              TEXT NOT NULL,
  every_hours       SMALLINT NOT NULL CHECK (every_hours BETWEEN 1 AND 24),
  days              SMALLINT NOT NULL CHECK (days BETWEEN 1 AND 14),
  budget_cents      INTEGER NOT NULL CHECK (budget_cents BETWEEN 1 AND 1000),
  spent_cents       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',
  checkins          JSONB NOT NULL DEFAULT '[]'::jsonb,
  state             TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (state IN ('proposed', 'declined', 'running', 'ended')),
  ended_reason      TEXT,
  next_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_investigations_source_idx
  ON homeroom_bot_investigations (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS homeroom_bot_investigations_running_idx
  ON homeroom_bot_investigations (user_id) WHERE state = 'running';
COMMENT ON TABLE homeroom_bot_investigations IS 'staging:private';

-- One look into a project's code (homeroom-bot-thread-tools/look-into.js):
-- a read-only turn of the bot's on the platform's cheap model, asked from a
-- chat (`message_id`, run by the bot-look machine) or by an investigation's
-- check-in. One running per person at a time. What it cost counts toward
-- the person's weekly building time when `charged` (homeroom-bot-dm.js
-- weeklySpentCents). `deliver`: whether the chat that asked took its
-- findings at once ('inline'), or stopped waiting and the findings are
-- posted in that chat when the look ends ('post').
CREATE TABLE IF NOT EXISTS homeroom_bot_looks (
  id               BIGSERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id           INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id       INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  conversation_id  INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       INTEGER,
  thread_root_id   INTEGER,
  investigation_id BIGINT REFERENCES homeroom_bot_investigations(id) ON DELETE CASCADE,
  checkin          INTEGER,
  question         TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed')),
  deliver          TEXT NOT NULL DEFAULT 'inline' CHECK (deliver IN ('inline', 'post')),
  summary          TEXT,
  answered         BOOLEAN,
  worth_acting     BOOLEAN,
  line             TEXT,
  files_read       INTEGER,
  files            JSONB,
  checks           JSONB,
  error            TEXT,
  model            TEXT,
  cost_usd         NUMERIC(18,8),
  duration_ms      INTEGER,
  charged          BOOLEAN NOT NULL DEFAULT TRUE,
  posted_message_id INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_looks_message_idx
  ON homeroom_bot_looks (message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_looks_checkin_idx
  ON homeroom_bot_looks (investigation_id, checkin) WHERE investigation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_looks_running_idx
  ON homeroom_bot_looks (user_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS homeroom_bot_looks_week_idx ON homeroom_bot_looks (user_id, created_at) WHERE charged;
COMMENT ON TABLE homeroom_bot_looks IS 'staging:private';
