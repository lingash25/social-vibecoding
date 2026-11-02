-- Homeroom bot parity, P8: pictures from an outside image model
-- (services/bot-pictures.js). Homeroom bot makes them in a person's chat
-- (make_pictures, a gallery card under its reply) and a build makes them
-- from its worker (usernode-image). Each asking is one row here: who it was
-- for, whose weekly building time paid for it (homeroom-bot-dm.js
-- weeklySpentCents adds `cost_usd` to the person's week), and what it cost;
-- each picture it made is a row of homeroom_bot_picture_images, its bytes
-- in the platform media store (services/media-store.js), never in a
-- message's metadata.
CREATE TABLE IF NOT EXISTS homeroom_bot_pictures (
  id               BIGSERIAL PRIMARY KEY,
  -- Whose week paid for it; NULL once that account is deleted.
  payer_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- The chat it was made in, whose members may see it; NULL for a build's.
  conversation_id  INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  -- The build session that asked for it, for a build's.
  session_id       INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  -- The project it is for, when one was named.
  app_id           INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  purpose          VARCHAR(10) NOT NULL DEFAULT 'other'
    CHECK (purpose IN ('featured', 'app', 'design', 'other', 'build')),
  prompt           TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 1200),
  model            TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 255),
  -- How many pictures it made, which counts toward the weekly picture cap.
  images           INTEGER NOT NULL DEFAULT 0 CHECK (images >= 0),
  cost_usd         NUMERIC(12, 6),
  error            TEXT CHECK (error IS NULL OR char_length(error) <= 200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS homeroom_bot_pictures_payer_idx
  ON homeroom_bot_pictures (payer_user_id, created_at DESC);
COMMENT ON TABLE homeroom_bot_pictures IS 'staging:private';

-- One picture: `letter` A to D, and `variant` light or dark when it was
-- asked for in both. `id` is its address (GET
-- /api/conversations/homeroom-bot/pictures/:id, for the chat's members).
CREATE TABLE IF NOT EXISTS homeroom_bot_picture_images (
  id            VARCHAR(32) PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  picture_id    BIGINT NOT NULL REFERENCES homeroom_bot_pictures(id) ON DELETE CASCADE,
  letter        CHAR(1) NOT NULL CHECK (letter IN ('A', 'B', 'C', 'D')),
  variant       VARCHAR(5) CHECK (variant IS NULL OR variant IN ('light', 'dark')),
  content_type  VARCHAR(32) NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width         INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 8192),
  height        INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 8192),
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  object_key    TEXT NOT NULL REFERENCES media_objects(object_key),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS homeroom_bot_picture_images_picture_idx
  ON homeroom_bot_picture_images (picture_id);
CREATE INDEX IF NOT EXISTS homeroom_bot_picture_images_object_idx
  ON homeroom_bot_picture_images (object_key);
COMMENT ON TABLE homeroom_bot_picture_images IS 'staging:private';

-- The pictures a person added to a design (a gallery's Add to the design):
-- the designer is told each one's address for the thread's next version
-- (design-bot.js designPrompt). [{ id, label, width, height }], newest last.
ALTER TABLE design_threads ADD COLUMN IF NOT EXISTS pictures JSONB NOT NULL DEFAULT '[]'::jsonb;
