-- Migration 007: Title System Phase 1
-- Toontown-style custom title system — data foundation.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

-- 1. Title unlocks table — tracks which words each player has unlocked
CREATE TABLE IF NOT EXISTS title_unlocks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  word_id     TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_title_unlocks_user ON title_unlocks (user_id);

-- 2. Profile columns for active title selection
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS title_slot1 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_slot2 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_slot3 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_builder_unlocked BOOLEAN NOT NULL DEFAULT false;

-- 3. RLS policies
ALTER TABLE title_unlocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Title unlocks: owner read"
  ON title_unlocks FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Title unlocks: owner insert"
  ON title_unlocks FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Title unlocks: owner update"
  ON title_unlocks FOR UPDATE
  USING (user_id = auth.uid());
