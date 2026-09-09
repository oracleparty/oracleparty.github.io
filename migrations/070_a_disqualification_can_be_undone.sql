-- ============================================
-- 070 — A DISQUALIFICATION CAN BE UNDONE
--
-- Asked for by the owner: "need to be able to un disqualify round if done by
-- accident."
--
-- Disqualifying is one tap on the reveal screen, it is not confirmed, and it is
-- the single most consequential thing a host can do to a round: every answer in
-- it is set to wrong and worth nothing, every wager is refunded, and — since
-- 068 — the round is flagged so the wager really is handed back. Until now
-- there was no way back from a mis-tap, on any screen in the app.
--
-- ---------------------------------------------------------------------------
-- WHAT IT RESTORES, AND WHY THAT IS POSSIBLE AT ALL
--
-- `answers.auto_correct` holds the verdict FUZZY MATCHING reached at submit
-- time, and 049 says in as many words that disqualifying must not touch it —
-- the gap between it and `is_correct` is `times_overridden`, the column this
-- project trusts most for finding a bad answer key. That decision is what makes
-- an undo possible: the original verdict was never destroyed.
--
-- The score is RECOMPUTED from the wager rather than remembered, using exactly
-- op_set_judgement's rule (049) — the wager on a correct answer, nothing on a
-- wrong one, and the final round the only one that subtracts. One rule, and
-- storing a "score before" column would be a second copy of it that could drift.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT RESTORE, SAID PLAINLY
--
-- A HOST'S OWN OVERRIDE FROM BEFORE THE DISQUALIFICATION IS LOST. If the host
-- had marked somebody right against the machine's verdict and then threw the
-- round out, undoing puts the MACHINE's verdict back, not theirs — because
-- op_disqualify_round overwrote `is_correct` and only `auto_correct` survived.
-- The host can flip it again from the same screen. Storing a third copy of the
-- verdict to cover this would be a column that exists for one rare sequence and
-- is wrong whenever anything else edits an answer.
--
-- `history_recorded` IS CLEARED so the client can record the round's mastery
-- again, which is the exact mirror of the revoke that disqualifying performs.
-- Without it the marker would still read "already counted" and the attempt
-- would stay revoked for ever.
--
-- ---------------------------------------------------------------------------
-- The JavaScript is safe to deploy before this is run: the button simply does
-- not appear until op_undisqualify_round answers.
-- ============================================


CREATE OR REPLACE FUNCTION op_undisqualify_round(
  p_room_id uuid,
  p_question_number int,
  p_caller_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r rooms;
  total int;
  is_final boolean;
  n int;
BEGIN
  -- The same guard as op_disqualify_round, and for the same reason: throwing a
  -- round out and putting it back are one power, not two.
  IF NOT op_is_room_host(p_room_id, p_caller_id) THEN RETURN -1; END IF;

  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF NOT FOUND THEN RETURN -1; END IF;

  total := op_room_total_questions(r);
  is_final := p_question_number >= total;

  UPDATE answers a
     SET is_correct = coalesce(a.auto_correct, false),
         score_earned = CASE
           WHEN coalesce(a.auto_correct, false) THEN coalesce(a.wager, 0)
           WHEN is_final THEN -coalesce(a.wager, 0)
           ELSE 0
         END,
         disqualified = false,
         -- The mirror of the revoke the client runs when a round is thrown out.
         -- record_round_history (043) refuses a round whose marker is already
         -- set, so without this the attempt would stay revoked for ever.
         history_recorded = false
   WHERE a.room_id = p_room_id
     AND a.question_number = p_question_number
     -- ONLY A ROUND THAT WAS ACTUALLY THROWN OUT. Without this, a mistyped
     -- question number would silently rewrite every host override in a live
     -- round back to the machine's verdict.
     AND coalesce(a.disqualified, false);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION op_undisqualify_round(uuid, int, uuid) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'op_undisqualify_round installed' AS thing,
    CASE WHEN to_regprocedure('op_undisqualify_round(uuid,int,uuid)') IS NOT NULL
         THEN 'ok' ELSE 'FAIL missing' END AS verdict

  UNION ALL SELECT 2, 'a host can call it',
    CASE WHEN to_regprocedure('op_undisqualify_round(uuid,int,uuid)') IS NOT NULL
          AND has_function_privilege('anon', 'op_undisqualify_round(uuid,int,uuid)', 'EXECUTE')
         THEN 'ok' ELSE 'FAIL not callable' END

  UNION ALL SELECT 3, 'it runs with the owner''s rights',
    COALESCE((SELECT CASE WHEN p.prosecdef THEN 'ok'
                          ELSE 'FAIL not SECURITY DEFINER — 049 revoked UPDATE on answers' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_undisqualify_round'), 'FAIL missing')

  UNION ALL SELECT 4, 'and only touches a round that was thrown out',
    COALESCE((SELECT CASE WHEN p.prosrc LIKE '%coalesce(a.disqualified, false)%'
                          THEN 'ok' ELSE 'FAIL it could rewrite a live round''s verdicts' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_undisqualify_round'), 'FAIL missing')
) v ORDER BY ord;
