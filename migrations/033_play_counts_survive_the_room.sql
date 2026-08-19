-- ============================================
-- Migration 033 — stop play counts being deleted the moment they are earned
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- THE BUG, measured 2026-08-19 rather than guessed:
--
--   game_plays_room_id_fkey   -> rooms   ON DELETE CASCADE
--   game_plays_player_id_fkey -> players ON DELETE CASCADE
--
-- A room is deleted when the last player leaves it, and a player's row is
-- deleted when they leave. Both happen at the end of every single game. So
-- every play record was destroyed within seconds of being written, and
-- game_plays held 0 rows against 4,859 questions and real games played.
--
-- get_category_play_counts() was installed and correct. js/ mapped its output
-- onto the category cards correctly. Nothing in the counting path was wrong —
-- the data was being deleted underneath it. This is why the symptom ("every
-- category shows 0 plays") pointed at the exact code that was working.
--
-- WHY DROP THE KEYS RATHER THAN SOFTEN THEM
--
-- ON DELETE SET NULL would keep the rows, but game_plays is a HISTORICAL
-- RECORD: it says a game in this category was played, by someone, at a time.
-- Once the game is over, the room does not exist and neither does that
-- players row — there is nothing left to point at, and a key that must be
-- nulled at the end of every game is not describing a real relationship.
--
-- The columns stay, and stay useful while the game is running:
-- completeGamePlay() and increment_questions_answered() both find a row by
-- room_id + player_id, and the unique index that makes that work is untouched.
-- They simply become plain identifiers afterwards rather than live references.
--
-- There is precedent in this schema: question_feedback.room_id is already a
-- plain TEXT column with no foreign key, for the same reason — feedback about
-- a question has to outlive the room it was given in.
--
-- WHAT THIS DOES NOT CHANGE
--
-- `answers` keeps its cascade, deliberately. Answers ARE scratch data for one
-- room and are documented as dying with it; question_stats and answer_tally
-- exist precisely because the durable part had to be recorded separately.
--
-- WHAT IS GONE FOR GOOD
--
-- Every play before today. Nothing can recover it — the rows were deleted, not
-- hidden. Counting starts from the next game played.
-- ============================================

ALTER TABLE game_plays
  DROP CONSTRAINT IF EXISTS game_plays_room_id_fkey;

ALTER TABLE game_plays
  DROP CONSTRAINT IF EXISTS game_plays_player_id_fkey;


-- --------------------------------------------
-- VERIFY — must print "(none)".
--
-- If it still lists a key, the constraint has a different name on this
-- database; send the output back rather than guessing at it.
-- --------------------------------------------

SELECT coalesce(
         string_agg(tc.constraint_name || ' -> ' || ccu.table_name ||
                    ' ON DELETE ' || rc.delete_rule, ', '),
         '(none)') AS remaining_foreign_keys_on_game_plays
  FROM information_schema.table_constraints tc
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
   AND rc.constraint_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.table_schema
 WHERE tc.table_name = 'game_plays'
   AND tc.constraint_type = 'FOREIGN KEY';
