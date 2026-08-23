-- ============================================
-- Migration 043 — record a round once, for everybody, instead of once per phone
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- THE BUG
--
-- `doReveal` writes the player's own question_history row from the player's
-- own browser. A phone asleep at the reveal records nothing; a phone awake
-- records a miss. Same event, two outcomes, decided by hardware — so two
-- people who both missed the same question can end up with different
-- permanent records, and one of them can improve their accuracy by having a
-- worse connection.
--
-- The owner settled the question this depends on: A MISS IS A MISS. It scores
-- 0 and burns a wager exactly as if the player had been there and got it
-- wrong, so it should count in accuracy the same way. Since Proficiency
-- (migration 040) reads the MOST RECENT verdict, a miss is undoable — get the
-- question right next time and it is gone.
--
-- THE SHAPE
--
-- SECURITY DEFINER, like record_question_outcome (025) and the two correction
-- functions (041), because question_history is scoped to its owner: a host
-- cannot write another player's row and gets no error when they try.
--
-- The guard is the same one used everywhere here — it is about the CLAIM, not
-- the caller. A host is very often a guest with no auth.uid(), so "the caller
-- must be the host" cannot be written. What CAN be checked is that the round
-- really happened: the function only records rows that exist in `answers` for
-- that room and that question, which is a record the game itself wrote.
--
-- IDEMPOTENCY, AND WHY THE MARKER LIVES ON `answers`
--
-- upsertQuestionHistory INCREMENTS. Calling it twice is two attempts, which is
-- the exact bug migration 041's amend function exists to undo — so a function
-- called from a reveal, which Realtime can re-fire for the same question, MUST
-- refuse to count twice.
--
-- The marker is `answers.history_recorded`, and it is deliberately not on
-- question_history: revoke_question_history DELETES that row when it was the
-- player's only sighting, which would take any marker with it and let a
-- re-render re-add the attempt the host had just thrown out. `answers` is
-- untouched by the correction functions, and it dies with the room, which is
-- exactly as long as the marker needs to live.
-- ============================================


-- --------------------------------------------
-- The marker. Nothing else reads it.
-- --------------------------------------------
ALTER TABLE answers
  ADD COLUMN IF NOT EXISTS history_recorded boolean NOT NULL DEFAULT false;

-- Every call filters on exactly this, once per round.
CREATE INDEX IF NOT EXISTS answers_history_pending_idx
  ON answers (room_id, question_id)
  WHERE history_recorded = false;


-- --------------------------------------------
-- Record one round's history for every signed-in player in the room.
--
-- Returns how many players were recorded, so a caller can tell "nothing to do"
-- from "did nothing".
-- --------------------------------------------
CREATE OR REPLACE FUNCTION record_round_history(
  p_room_id     uuid,
  p_question_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recorded integer := 0;
BEGIN
  IF p_room_id IS NULL OR p_question_id IS NULL THEN
    RETURN 0;
  END IF;

  -- ONE statement, and the UPDATE that claims the marker comes FIRST on
  -- purpose. It takes the row locks, so a second caller — a host and a deputy
  -- can both be advancing — blocks there, and on waking re-tests
  -- `history_recorded = false`, matches nothing, and inserts nothing. Written
  -- the other way round, with the marker last, both callers would read the
  -- same unmarked rows and both would count the round.
  WITH marked AS (
    UPDATE answers a
       SET history_recorded = true
     WHERE a.room_id          = p_room_id
       AND a.question_id      = p_question_id
       AND a.history_recorded = false
    RETURNING a.id AS answer_id, a.player_id, a.is_correct
  ),
  -- DISTINCT ON guards the one case that would double-count within a single
  -- call: two answer rows for the same person. `answers` is unique on
  -- (room_id, player_id, question_number), but a rejoin creates a NEW player
  -- row and reassigning the old answers to it is a real path in this app, so
  -- one person can hold two rows through two player ids. Newest verdict wins,
  -- which is what last_correct means.
  pending AS (
    SELECT DISTINCT ON (p.user_id)
           p.user_id,
           COALESCE(m.is_correct, false) AS is_correct
      FROM marked m
      JOIN players p ON p.id = m.player_id
     -- Guests have no durable record to write to, deliberately: tracking what
     -- a guest has met means keeping a record of somebody who did not sign up.
     -- Their answer row is still marked, so it is not rescanned.
     WHERE p.user_id IS NOT NULL
       -- A bot's answer comes from a percentage somebody chose. Recording it
       -- would make this data partly that invented number.
       AND COALESCE(p.is_bot, false) = false
     ORDER BY p.user_id, m.answer_id DESC
  ),
  -- Deliberately NOT an upsert. `upsertQuestionHistory` in js/ is a
  -- read-then-write, which means nothing here guarantees a unique index on
  -- (user_id, question_id) — and ON CONFLICT without one raises 42P10 and
  -- kills the whole statement every time, for everyone. Update-then-insert
  -- needs no constraint, and the two sets cannot overlap: they read
  -- question_history from the same snapshot, so a row is in exactly one.
  updated AS (
    UPDATE question_history h
       SET times_seen    = h.times_seen + 1,
           times_correct = h.times_correct + CASE WHEN pd.is_correct THEN 1 ELSE 0 END,
           last_correct  = pd.is_correct,
           last_seen_at  = now()
      FROM pending pd
     WHERE h.user_id     = pd.user_id
       AND h.question_id = p_question_id
    RETURNING h.user_id
  ),
  inserted AS (
    INSERT INTO question_history (user_id, question_id, times_seen, times_correct, last_correct, last_seen_at)
    SELECT pd.user_id, p_question_id, 1,
           CASE WHEN pd.is_correct THEN 1 ELSE 0 END,
           pd.is_correct,
           now()
      FROM pending pd
     WHERE NOT EXISTS (
       SELECT 1 FROM question_history h2
        WHERE h2.user_id = pd.user_id AND h2.question_id = p_question_id)
    RETURNING user_id
  )
  SELECT ((SELECT count(*) FROM updated) + (SELECT count(*) FROM inserted))::integer
    INTO v_recorded;

  RETURN v_recorded;
END;
$$;


-- A guest host has no auth.uid() and must still be able to advance the game.
-- The guard above is what makes that acceptable: it records only rounds the
-- game itself wrote answer rows for.
GRANT EXECUTE ON FUNCTION record_round_history(uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY
--
-- Expect: one row, record_round_history / DEFINER / 2 arguments,
-- and answers.history_recorded present as a boolean.
-- --------------------------------------------

SELECT p.proname,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS runs_as,
       p.pronargs AS argument_count
  FROM pg_proc p
 WHERE p.proname = 'record_round_history';

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'answers' AND column_name = 'history_recorded';
