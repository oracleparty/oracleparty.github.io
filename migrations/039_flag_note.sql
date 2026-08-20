-- ============================================
-- Migration 039 — let a player say what "Other" means
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- The five flag reasons cover the common cases, and "Other" covers the rest by
-- telling the admin nothing at all. A flag with no reason is a report that
-- something is wrong with a question and no way to find out what — the admin
-- has to guess, and guessing about the question bank is exactly what this
-- project refuses to do everywhere else.
--
-- Deliberately optional and deliberately short. The flag itself is saved the
-- moment a reason is chosen, and the note is a follow-up UPDATE, so somebody
-- who taps "Other" and then puts their phone down has still filed the flag.
-- 280 characters because this is a sentence about one question, not a bug
-- report, and an unbounded text column on a table any visitor can write to is
-- an invitation.
-- ============================================

ALTER TABLE question_feedback
  ADD COLUMN IF NOT EXISTS flag_note text;

ALTER TABLE question_feedback
  DROP CONSTRAINT IF EXISTS question_feedback_flag_note_length;

ALTER TABLE question_feedback
  ADD CONSTRAINT question_feedback_flag_note_length
  CHECK (flag_note IS NULL OR char_length(flag_note) <= 280);


-- --------------------------------------------
-- VERIFY — should print one row: flag_note | text
-- --------------------------------------------

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'question_feedback'
   AND column_name = 'flag_note';
