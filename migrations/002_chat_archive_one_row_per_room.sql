-- Restructure chat_archive: one row per room with all messages as a JSON array.
-- Drop the old table and recreate with the new schema.

DROP TABLE IF EXISTS chat_archive;

CREATE TABLE chat_archive (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id    UUID NOT NULL UNIQUE,
  room_code  TEXT,
  category   TEXT,
  messages   JSONB NOT NULL DEFAULT '[]',
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for looking up archives by room
CREATE INDEX idx_chat_archive_room_id ON chat_archive (room_id);
