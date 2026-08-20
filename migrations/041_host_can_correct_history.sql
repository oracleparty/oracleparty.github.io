-- ============================================
-- Migration 041 — let a host's correction reach the player it is about
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- THE BUG
--
-- Migration 011 scopes question_history to its owner:
--
--     INSERT WITH CHECK (user_id = auth.uid())
--     UPDATE USING      (user_id = auth.uid())
--     -- and no DELETE policy at all
--
-- Every write in the app goes through a player's own browser, which is fine
-- for recording their own attempt. It is not fine for the two things a HOST
-- does on everyone's behalf:
--
--   * flipping a judgement — amendQuestionHistory
--   * throwing out a round — revokeQuestionHistory
--
-- Both land on the host's own row and are SILENTLY REFUSED for every other
-- player. No error: an RLS refusal returns zero rows and reports success. So a
-- host who corrects a wrongly-marked answer fixes it for themselves and for
-- nobody else, and a disqualified round keeps counting against everyone but
-- the host. revoke's delete branch is refused even for the caller, because
-- there is no DELETE policy for anyone.
--
-- The robot harness could not catch this. Its fake store has no RLS, so every
-- write it makes succeeds.
--
-- THE GUARD, AND WHAT IT CAN AND CANNOT DO
--
-- The obvious guard — "the caller must be the host" — cannot be written. A
-- host is very often a GUEST, and a guest has no auth.uid() to check. That is
-- the same wall described in CLAUDE.md #2: with guests in the game there is no
-- identity to authorise on.
--
-- So the guard is about the CLAIM rather than the caller: the correction is
-- only applied if that player really did answer that question in that room.
-- You cannot reach into a stranger's history from nowhere; you can only adjust
-- a record of a round that demonstrably happened. Somebody already inside the
-- room could still misuse it — but they can already edit the scoreboard
-- directly, so this opens nothing that was closed.
--
-- Same shape as record_question_outcome (migration 025): SECURITY DEFINER, so
-- the table stays shut to clients and every write goes through a function that
-- checks something first.
-- ============================================


-- --------------------------------------------
-- A host changed their mind about one answer.
--
-- Moves the verdict WITHOUT counting a second attempt. times_seen is
-- untouched: a correction is not a new sighting of the question, and treating
-- it as one is what gave a player 50% on a question they got right and the
-- host agreed they got right.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION amend_question_history(
  p_user_id     uuid,
  p_question_id uuid,
  p_room_id     uuid,
  p_is_correct  boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_correct boolean;
  v_seen         integer;
  v_correct      integer;
BEGIN
  IF p_user_id IS NULL OR p_question_id IS NULL OR p_room_id IS NULL THEN
    RETURN;
  END IF;

  -- The claim must correspond to a real round.
  IF NOT EXISTS (
    SELECT 1
      FROM answers a
      JOIN players p ON p.id = a.player_id
     WHERE a.room_id     = p_room_id
       AND a.question_id = p_question_id
       AND p.user_id     = p_user_id
  ) THEN
    RETURN;
  END IF;

  SELECT last_correct, times_seen, times_correct
    INTO v_last_correct, v_seen, v_correct
    FROM question_history
   WHERE user_id = p_user_id AND question_id = p_question_id;

  -- Nothing recorded to amend. Not an error: the player's own device writes
  -- that row, and a device that was asleep at the reveal never wrote one.
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(v_last_correct, false) = COALESCE(p_is_correct, false) THEN RETURN; END IF;

  UPDATE question_history
     SET times_correct = GREATEST(0, LEAST(v_seen,
                           v_correct + CASE WHEN p_is_correct THEN 1 ELSE -1 END)),
         last_correct  = COALESCE(p_is_correct, false)
   WHERE user_id = p_user_id AND question_id = p_question_id;
END;
$$;


-- --------------------------------------------
-- The round was disqualified — take the attempt back out.
--
-- A disqualified question must count neither for nor against anybody, so the
-- sighting is stepped back out rather than recorded as a miss. When it was the
-- only sighting the row goes entirely, which is why this needs to be a
-- function: there is no DELETE policy on question_history for any caller.
--
-- last_correct falls back to "have they ever got this right", because the true
-- previous verdict is not stored anywhere and that is the closest honest
-- answer.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION revoke_question_history(
  p_user_id     uuid,
  p_question_id uuid,
  p_room_id     uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_correct boolean;
  v_seen         integer;
  v_correct      integer;
  v_next_seen    integer;
  v_next_correct integer;
BEGIN
  IF p_user_id IS NULL OR p_question_id IS NULL OR p_room_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM answers a
      JOIN players p ON p.id = a.player_id
     WHERE a.room_id     = p_room_id
       AND a.question_id = p_question_id
       AND p.user_id     = p_user_id
  ) THEN
    RETURN;
  END IF;

  SELECT last_correct, times_seen, times_correct
    INTO v_last_correct, v_seen, v_correct
    FROM question_history
   WHERE user_id = p_user_id AND question_id = p_question_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_next_seen    := v_seen - 1;
  v_next_correct := GREATEST(0, v_correct - CASE WHEN COALESCE(v_last_correct, false) THEN 1 ELSE 0 END);

  IF v_next_seen <= 0 THEN
    DELETE FROM question_history
     WHERE user_id = p_user_id AND question_id = p_question_id;
  ELSE
    UPDATE question_history
       SET times_seen    = v_next_seen,
           times_correct = v_next_correct,
           last_correct  = (v_next_correct > 0)
     WHERE user_id = p_user_id AND question_id = p_question_id;
  END IF;
END;
$$;


-- A guest host has no auth.uid() and must still be able to correct a round, so
-- anon needs this. The guard above is what makes that acceptable: it is about
-- whether the round happened, not about who is asking.
GRANT EXECUTE ON FUNCTION amend_question_history(uuid, uuid, uuid, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_question_history(uuid, uuid, uuid)          TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — both functions, both DEFINER, 4 and 3 arguments.
-- --------------------------------------------

SELECT p.proname,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS runs_as,
       p.pronargs AS argument_count
  FROM pg_proc p
 WHERE p.proname IN ('amend_question_history', 'revoke_question_history')
 ORDER BY p.proname;
