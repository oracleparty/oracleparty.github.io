-- ============================================
-- Migration 024 — three fixes, verified against the live database
-- by scripts/probe-db.mjs on 2026-08-12.
--
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- Safe to run more than once.
-- ============================================


-- --------------------------------------------
-- 1. ALTERNATE ACCEPTABLE ANSWERS
--
-- The app reads questions.acceptable_answers (js/game/state.js), but the
-- column does not exist on the live table, so getAlternates() returns an
-- empty list for all ~4,859 questions. Every answer is therefore judged
-- against exactly one string, and correct variants ("JFK" for "John F.
-- Kennedy") are marked wrong until the host manually overrides.
--
-- migrations/010 already tried to INSERT into this column, so this was
-- always the intent — the column just never got created.
-- --------------------------------------------

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS acceptable_answers text[] DEFAULT '{}';

-- Multiple-choice questions already carry their distractors; nothing to
-- backfill there. For open questions the array starts empty and is filled in
-- from the admin Question Health page as bad judgements are spotted.

COMMENT ON COLUMN questions.acceptable_answers IS
  'Extra answers judged correct, in addition to correct_answer. Fuzzy matching applies to each.';


-- --------------------------------------------
-- 2. CATEGORY PLAY COUNTS
--
-- Two separate faults, both confirmed against the live database:
--
--   a) game_plays had no `subcategory` column, but insertGamePlay() adds that
--      field whenever a subcategory is chosen (js/db/players.js). Postgres
--      rejects the whole INSERT for an unknown column, and the failure is only
--      logged, never surfaced. So every game played with a subcategory
--      selected recorded nothing at all — which is why play counts worked
--      once and then silently stopped.
--
--   b) get_category_play_counts() returned 404 — never installed — so the
--      category cards had nothing to read even for games that did record.
--
-- SECURITY DEFINER so it can aggregate game_plays without exposing individual
-- rows to clients.
-- --------------------------------------------

ALTER TABLE game_plays
  ADD COLUMN IF NOT EXISTS subcategory text;

CREATE OR REPLACE FUNCTION get_category_play_counts()
RETURNS TABLE (category text, subcategory text, play_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Category-level totals (subcategory NULL), then subcategory-level totals.
  SELECT gp.category, NULL::text AS subcategory, count(*)::bigint AS play_count
    FROM game_plays gp
   WHERE gp.category IS NOT NULL
   GROUP BY gp.category
  UNION ALL
  SELECT gp.category, gp.subcategory, count(*)::bigint
    FROM game_plays gp
   WHERE gp.category IS NOT NULL AND gp.subcategory IS NOT NULL
   GROUP BY gp.category, gp.subcategory;
$$;

GRANT EXECUTE ON FUNCTION get_category_play_counts() TO anon, authenticated;

-- Counts are derived from game_plays, which stores the category recorded at
-- the time each game was played. Renaming or re-organising categories in
-- js/categories.js therefore cannot erase history — old rows keep their own
-- label. The counter can only reset if game_plays itself is emptied.


-- --------------------------------------------
-- 3. ADMIN WRITE ACCESS TO QUESTIONS
--
-- questions has a SELECT policy and no write policy at all, so admin edits in
-- js/admin.js are discarded by RLS with zero rows affected and NO error. The
-- UI then reports "Saved!" while saving nothing.
--
-- This grants UPDATE only to signed-in admins. Players still cannot write.
--
-- CORRECTED AFTER THE FACT. This policy originally matched auth.uid() against
-- profiles.id. profiles has both an id and a user_id, and it is user_id that
-- holds the auth user's id, so the predicate matched no row and the policy
-- granted nothing -- leaving the very bug described above in place. Fixed here
-- so a replay from zero is correct; migration 028 repairs any database that
-- already ran the original.
-- --------------------------------------------

DROP POLICY IF EXISTS "Questions: admins can update" ON questions;
CREATE POLICY "Questions: admins can update"
  ON questions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid() AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid() AND p.is_admin = true
    )
  );


-- --------------------------------------------
-- VERIFY — this should report all three as installed.
-- --------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'questions' AND column_name = 'acceptable_answers')  AS alternates_column,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'get_category_play_counts')                             AS playcount_function,
  (SELECT count(*) FROM pg_policies
    WHERE tablename = 'questions' AND cmd = 'UPDATE')                       AS admin_write_policy;
