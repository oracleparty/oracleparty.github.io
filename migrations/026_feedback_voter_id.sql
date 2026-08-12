-- ============================================
-- Migration 026 — one vote per person per question
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- question_feedback was unique on (question_id, room_id, player_name), which
-- caused two problems:
--
--   1. Vote inflation. room_id is part of the key, so the same person rating
--      the same question in a new game created a second row, and every one of
--      them counted toward that question's totals.
--
--   2. Name collisions. Guests share display names — the live profiles table
--      already holds several accounts called "New Player" — so two guests with
--      the same name in one room overwrote each other's votes.
--
-- voter_id fixes both. It is 'user:<uuid>' for signed-in players and
-- 'device:<uuid>' for guests, so guests get a durable identity without an
-- account and their previous ratings show as already selected on return.
-- ============================================

ALTER TABLE question_feedback
  ADD COLUMN IF NOT EXISTS voter_id text;

-- Backfill anything already recorded. The live table is empty, so this is a
-- no-op today, but it keeps the migration correct if run against a copy that
-- does hold rows: pre-existing rows are attributed to a legacy identity built
-- from the name they were cast under.
UPDATE question_feedback
   SET voter_id = 'legacy:' || COALESCE(player_name, 'unknown')
 WHERE voter_id IS NULL;

-- Collapse any duplicates the old key allowed, keeping the most recent vote,
-- so the unique index below can be created.
DELETE FROM question_feedback a
 USING question_feedback b
 WHERE a.question_id = b.question_id
   AND a.voter_id    = b.voter_id
   AND a.ctid        < b.ctid;

ALTER TABLE question_feedback
  ALTER COLUMN voter_id SET NOT NULL;

-- The old key permitted one row per room; this permits one per person, ever.
-- Changing your mind updates that row instead of adding another vote.
DROP INDEX IF EXISTS question_feedback_question_id_room_id_player_name_key;
ALTER TABLE question_feedback
  DROP CONSTRAINT IF EXISTS question_feedback_question_id_room_id_player_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS question_feedback_voter_unique
  ON question_feedback (question_id, voter_id);

CREATE INDEX IF NOT EXISTS idx_qf_voter ON question_feedback (voter_id);


-- --------------------------------------------
-- VERIFY — voter_column and unique_index should both be 1.
-- --------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'question_feedback' AND column_name = 'voter_id')      AS voter_column,
  (SELECT count(*) FROM pg_indexes
    WHERE tablename = 'question_feedback'
      AND indexname = 'question_feedback_voter_unique')                       AS unique_index;
