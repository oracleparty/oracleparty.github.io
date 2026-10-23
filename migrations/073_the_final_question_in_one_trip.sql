-- ============================================
-- 073 — THE FINAL QUESTION IN ONE TRIP
--
-- Pressing "Reveal Question" on the final wager screen swaps in a question that
-- matches the difficulty vote and then moves the room to it. That was TWO round
-- trips from the presser's phone, one after the other:
--
--   1. write rooms.question_ids (the swapped list) and clear the clock;
--   2. op_set_phase(..., 'final_question').
--
-- The order is load-bearing — every phone re-reads the list when the phase
-- arrives, so the list must land first — which is why the second could never
-- start until the first came back. CLAUDE.md measured the cost and left it
-- open: on a 12-second link the room took ~29 seconds to reach the final
-- question. "The bug reported was the host being locked out of their own
-- round; that is gone. The slowness is not."
--
-- op_reveal_final_question does both in ONE call, in the same order, inside
-- one transaction. Realtime still delivers two UPDATEs — the list, then the
-- phase — so every phone sees exactly what it saw before, a round trip sooner.
--
-- ---------------------------------------------------------------------------
-- IT DELEGATES TO op_set_phase, IT DOES NOT COPY IT
--
-- The phase rules (who may advance, never skip a round, clear the round's
-- clock) live in op_set_phase and nowhere else. A second copy here would be
-- this project's most repeated fault — one rule stated twice and fixed once.
-- So this function writes the list and then CALLS op_set_phase, and returns its
-- verdict word for word.
--
-- IF op_set_phase DECLINES, THE LIST IS PUT BACK. The list write and the phase
-- write sit in one sub-transaction, and a refusal raises inside it, so a caller
-- who may not advance the room cannot change its question list either. Without
-- that, a refused tap would leave a room asking a question its players were
-- never moved to — the "screen must show the question the room is asking" bug.
--
-- ---------------------------------------------------------------------------
-- SAFE TO DEPLOY IN EITHER ORDER
--
-- The client calls this first and, if PostgREST answers "no such function"
-- (PGRST202), does the old two-step exactly as before. So the JavaScript works
-- with or without this migration — it is merely slower without it.
--
-- p_question_ids IS uuid[]. If the live column were text[] the assignment would
-- still work (uuid to text is an assignment cast); the other way round would
-- not, which is why the parameter is the narrower type.
-- ============================================

CREATE OR REPLACE FUNCTION op_reveal_final_question(
  p_room_id      uuid,
  p_caller_id    uuid,
  p_question     int,
  p_question_ids uuid[]
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_verdict text := 'not allowed';
BEGIN
  IF p_room_id IS NULL OR p_caller_id IS NULL
     OR p_question_ids IS NULL OR array_length(p_question_ids, 1) IS NULL THEN
    RETURN 'bad request';
  END IF;

  -- Asked BEFORE anything is written, so a refusal costs nothing at all. The
  -- sub-transaction below is the backstop for op_set_phase's other refusals.
  IF NOT op_may_advance(p_room_id, p_caller_id) THEN
    RETURN 'not allowed';
  END IF;

  BEGIN
    -- THE LIST FIRST. Every client re-reads it when the phase arrives.
    UPDATE rooms
       SET question_ids = p_question_ids,
           question_started_at = NULL
     WHERE id = p_room_id;

    v_verdict := op_set_phase(p_room_id, p_caller_id, NULL, 'final_question', p_question);

    IF v_verdict IS DISTINCT FROM 'ok' THEN
      -- Roll the list back with it. A plpgsql variable survives the rollback of
      -- its sub-transaction, so the verdict is still there to return.
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'op_reveal_final_question declined';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    RETURN v_verdict;
  END;

  RETURN v_verdict;
END;
$$;

REVOKE ALL ON FUNCTION op_reveal_final_question(uuid, uuid, int, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION op_reveal_final_question(uuid, uuid, int, uuid[]) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION — a SELECT, not a DO block with RAISE NOTICE, because the
-- Supabase SQL editor may not show notices. Every row should read ok.
-- APPLIED 2026-10-23: the owner reported all three ok.
-- ---------------------------------------------------------------------------

SELECT 'installed as DEFINER' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                          WHERE proname = 'op_reveal_final_question' AND prosecdef)
            THEN 'ok' ELSE 'FAIL' END AS result
UNION ALL
-- It calls op_set_phase, so 073 is only as good as the op_set_phase it finds.
-- 069's version carries the words below, so one that predates 069 reads FAIL.
SELECT 'op_set_phase is the 069 version',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                          WHERE proname = 'op_set_phase' AND prosrc LIKE '%skips a round%')
            THEN 'ok' ELSE 'FAIL — op_set_phase predates 069' END
UNION ALL
SELECT 'players can call it',
       CASE WHEN has_function_privilege('anon',
              'op_reveal_final_question(uuid, uuid, int, uuid[])', 'EXECUTE')
            THEN 'ok' ELSE 'FAIL — players cannot call it' END;
