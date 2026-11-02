-- Homeroom bot parity, P4 and P5: batches of requests worked through from a
-- chat with the bot, and notes sent into one of its builds while it runs.

-- P4: "work through these" (homeroom-bot-thread-tools/batch.js work_through).
-- One row per batch card the bot put under a reply: whose it is, which
-- project and requests, the reply that carries the card (`message_id`, set
-- once the card is first tapped or refreshed), and the caps Build raised for
-- it. While a batch runs, its requests (and only those) may go past the
-- per-person limit, up to `per_person`, and past the project's hold on the
-- bot's open proposals, up to `proposals_per_app`: the project's owner (or an
-- admin) working through the project's own requests (homeroom-bot-batches.js
-- raiseFor). The roll-up the card shows is read from the bot's records
-- (homeroom-bot-track.js), never kept here.
CREATE TABLE IF NOT EXISTS homeroom_bot_batches (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id            INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id   INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id        INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  numbers           INTEGER[] NOT NULL,
  started_numbers   INTEGER[] NOT NULL DEFAULT '{}',
  per_person        INTEGER,
  proposals_per_app INTEGER,
  state             TEXT NOT NULL DEFAULT 'proposed',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_batches_state_check CHECK (state IN ('proposed', 'running', 'done')),
  CONSTRAINT homeroom_bot_batches_numbers_check CHECK (cardinality(numbers) BETWEEN 1 AND 20),
  CONSTRAINT homeroom_bot_batches_per_person_check CHECK (per_person IS NULL OR per_person BETWEEN 1 AND 6),
  CONSTRAINT homeroom_bot_batches_proposals_check CHECK (proposals_per_app IS NULL OR proposals_per_app BETWEEN 1 AND 10)
);
COMMENT ON TABLE homeroom_bot_batches IS 'staging:private';
-- The batches running on a project: what the lane and the proposal hold read.
CREATE INDEX IF NOT EXISTS homeroom_bot_batches_running_idx
  ON homeroom_bot_batches (app_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS homeroom_bot_batches_user_idx ON homeroom_bot_batches (user_id, id DESC);

-- P5: a note into a running build (homeroom-bot-thread-tools/steer.js
-- add_to_build, and stop_and_redo's offer). `run_id` is the build's run and
-- `session_id` its session, once it has one: the build's Stop hook asks for
-- the notes waiting on its session (POST /api/internal/sessions/:id/
-- build-notes/take) and each is delivered once. A note whose build ended
-- first is `missed`, and its card offers the change's next update instead.
-- `kind` 'redo' is a Stop and redo offered under a reply: nothing stops until
-- it is tapped (`redone`), or `kept` going with the note sent in.
CREATE TABLE IF NOT EXISTS homeroom_bot_build_notes (
  id              SERIAL PRIMARY KEY,
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  issue_number    INTEGER NOT NULL,
  run_id          INTEGER REFERENCES homeroom_bot_runs(id) ON DELETE CASCADE,
  session_id      INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER REFERENCES conversation_messages(id) ON DELETE SET NULL,
  note            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'note',
  state           TEXT NOT NULL DEFAULT 'waiting',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  settled_at      TIMESTAMPTZ,
  CONSTRAINT homeroom_bot_build_notes_kind_check CHECK (kind IN ('note', 'redo')),
  CONSTRAINT homeroom_bot_build_notes_state_check
    CHECK (state IN ('waiting', 'delivered', 'missed', 'forwarded', 'offered', 'redone', 'kept', 'gone'))
);
COMMENT ON TABLE homeroom_bot_build_notes IS 'staging:private';
CREATE INDEX IF NOT EXISTS homeroom_bot_build_notes_waiting_idx
  ON homeroom_bot_build_notes (session_id) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS homeroom_bot_build_notes_run_idx
  ON homeroom_bot_build_notes (run_id) WHERE state IN ('waiting', 'redone');
CREATE INDEX IF NOT EXISTS homeroom_bot_build_notes_request_idx
  ON homeroom_bot_build_notes (app_id, issue_number, id DESC);
