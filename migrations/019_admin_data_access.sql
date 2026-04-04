-- Migration 019: Admin data access improvements
-- Adds missing columns to chat_archive and delete policy for error_logs.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

-- Add optional metadata columns to chat_archive (may already exist)
DO $$
BEGIN
  ALTER TABLE chat_archive ADD COLUMN IF NOT EXISTS host_name TEXT;
  ALTER TABLE chat_archive ADD COLUMN IF NOT EXISTS player_count INT;
  ALTER TABLE chat_archive ADD COLUMN IF NOT EXISTS game_started_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Allow admins to delete old error logs
CREATE POLICY "Admins can delete error logs"
  ON error_logs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.is_admin = true
    )
  );

-- Allow admins to read chat_archive
ALTER TABLE chat_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read chat archive"
  ON chat_archive FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.is_admin = true
    )
  );

-- Allow anyone to insert chat archives (game end triggers this)
CREATE POLICY "Anyone can insert chat archive"
  ON chat_archive FOR INSERT
  WITH CHECK (true);

-- Allow admins to read game_plays
DO $$
BEGIN
  ALTER TABLE game_plays ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

CREATE POLICY "Admins can read game plays"
  ON game_plays FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.is_admin = true
    )
  );
