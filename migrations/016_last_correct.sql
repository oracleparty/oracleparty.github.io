-- Add last_correct column to question_history for mastery tracking.
-- "Mastered" = last answer was correct. Mastery can go DOWN.

ALTER TABLE question_history ADD COLUMN IF NOT EXISTS last_correct BOOLEAN DEFAULT false;

-- Backfill: assume mastered if they ever got it correct
UPDATE question_history SET last_correct = (times_correct > 0) WHERE last_correct IS NULL;
