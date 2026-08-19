-- ============================================
-- Migration 034 — count every round, not every room
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
-- Run migration 033 first if you have not.
--
-- THE PROBLEM
--
-- A play record is keyed on (room_id, player_id), and a room survives "Play
-- Again". So a group playing six rounds together in one sitting wrote to the
-- same record six times and counted as ONE play each. Plays were under-counted
-- for exactly the people who play the most.
--
-- WHY NOT JUST ALLOW SEVERAL RECORDS PER ROOM
--
-- Because two other things find a record by room_id + player_id and nothing
-- else: completeGamePlay() marks it finished with the final score, and
-- increment_questions_answered() counts questions as they are answered. With
-- several rows per person per room, both would hit every round the group had
-- ever played in that room — marking old games complete with a new game's
-- score. The fix for a counting bug would have quietly corrupted two other
-- things.
--
-- So the record stays one-per-person-per-room and learns to count rounds.
--
-- IDEMPOTENT BY DESIGN
--
-- p_game_key is the room's countdown timestamp, which is rewritten at the
-- start of every game and is the same value on every player's phone. The
-- counter only moves when the key CHANGES, so the client can call this as
-- often as it likes — on a re-render, a reconnect, a Realtime echo — and a
-- round is still counted once. That matters because the caller fires from a
-- phase transition, which is not guaranteed to happen exactly once.
-- ============================================

ALTER TABLE game_plays
  ADD COLUMN IF NOT EXISTS games_played integer NOT NULL DEFAULT 1;

ALTER TABLE game_plays
  ADD COLUMN IF NOT EXISTS last_game_key text;


-- --------------------------------------------
-- Record the start of a round.
--
-- Not SECURITY DEFINER: game_plays already allows anyone to insert and update
-- (migration 021), so this needs no extra privilege, and a function that runs
-- as its owner when it does not have to is a permission widening waiting to be
-- forgotten about.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION record_game_play(
  p_room_id         uuid,
  p_player_id       uuid,
  p_player_name     text,
  p_category        text,
  p_subcategory     text,
  p_total_questions integer,
  p_game_key        text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO game_plays AS gp
      (room_id, player_id, player_name, category, subcategory,
       total_questions, questions_answered, started_at, completed,
       games_played, last_game_key)
  VALUES
      (p_room_id, p_player_id, p_player_name, p_category, p_subcategory,
       p_total_questions, 0, now(), false,
       1, p_game_key)
  ON CONFLICT (room_id, player_id) DO UPDATE SET
      player_name        = excluded.player_name,
      category           = excluded.category,
      subcategory        = excluded.subcategory,
      total_questions    = excluded.total_questions,
      -- A new round starts fresh; a repeated call for the SAME round must not
      -- reset a count that is already climbing.
      questions_answered = CASE WHEN gp.last_game_key IS DISTINCT FROM p_game_key
                                THEN 0 ELSE gp.questions_answered END,
      started_at         = CASE WHEN gp.last_game_key IS DISTINCT FROM p_game_key
                                THEN now() ELSE gp.started_at END,
      completed          = CASE WHEN gp.last_game_key IS DISTINCT FROM p_game_key
                                THEN false ELSE gp.completed END,
      games_played       = gp.games_played
                           + CASE WHEN gp.last_game_key IS DISTINCT FROM p_game_key
                                  THEN 1 ELSE 0 END,
      last_game_key      = p_game_key;
END;
$$;

GRANT EXECUTE ON FUNCTION record_game_play(uuid, uuid, text, text, text, integer, text)
  TO anon, authenticated;


-- --------------------------------------------
-- Count rounds rather than records.
--
-- Same shape as before — category, subcategory, play_count — so nothing in
-- js/ has to change to read it.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION get_category_play_counts()
RETURNS TABLE (category text, subcategory text, play_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT gp.category, NULL::text AS subcategory, sum(gp.games_played)::bigint AS play_count
    FROM game_plays gp
   WHERE gp.category IS NOT NULL
   GROUP BY gp.category
  UNION ALL
  SELECT gp.category, gp.subcategory, sum(gp.games_played)::bigint
    FROM game_plays gp
   WHERE gp.category IS NOT NULL AND gp.subcategory IS NOT NULL
   GROUP BY gp.category, gp.subcategory;
$$;

GRANT EXECUTE ON FUNCTION get_category_play_counts() TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — both numbers must be 1.
-- --------------------------------------------

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'game_plays' AND column_name = 'games_played')  AS games_played_column,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'record_game_play')                                AS recorder_function;
