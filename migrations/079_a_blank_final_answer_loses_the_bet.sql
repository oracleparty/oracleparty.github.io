-- ============================================
-- 079 — a blank final answer loses the bet (owner, 2026-11-02)
--
-- Reported after a real game: "my friend bet 20, but in the end it showed he
-- bet zero". He had locked 20, left during the final question, and came back
-- to a closed round. The fill (066) converted his __WAGER_LOCKED__ placeholder
-- into a blank and KEPT the 20 on the row (050) — but scored it 0, by design:
-- going away was never to cost more than the loss itself.
--
-- The owner's rule replaces that: a bet is a bet. A blank under a locked
-- final wager scores -wager. What does NOT change:
--   * a player with no placeholder (never locked a wager) still gets a blank
--     at wager 0, so absence alone costs nothing;
--   * every regular round still scores a blank at 0 — they never subtract;
--   * a real answer is still never overwritten (the WHERE below is 066's).
--
-- Identical to 066 apart from the score_earned line.
-- ============================================

CREATE OR REPLACE FUNCTION op_fill_blank_answers(p_room_id uuid, p_question_number int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r         rooms;
  p         players;
  qid       uuid;
  total     int;
  is_final  boolean;
  written   int := 0;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF r.id IS NULL THEN RETURN 0; END IF;

  total    := op_room_total_questions(r);
  is_final := (p_question_number >= total);
  qid      := r.question_ids[p_question_number + 1];   -- Postgres arrays are 1-based

  FOR p IN SELECT * FROM players WHERE room_id = p_room_id LOOP
    INSERT INTO answers (room_id, player_id, question_number, question_id,
                         wager, submitted_answer, is_correct, auto_correct, score_earned)
    VALUES (p_room_id, p.id, p_question_number, qid,
            CASE WHEN is_final THEN 0 ELSE op_next_wager(p_room_id, p.id, total) END,
            '', false, false, 0)
    ON CONFLICT (room_id, player_id, question_number) DO UPDATE
      SET submitted_answer = '',
          wager            = CASE
                               WHEN answers.question_id IS DISTINCT FROM EXCLUDED.question_id
                                    AND answers.question_id IS NOT NULL
                                 THEN EXCLUDED.wager
                               ELSE COALESCE(answers.wager, EXCLUDED.wager)
                             END,
          question_id      = EXCLUDED.question_id,
          is_correct       = false,
          auto_correct     = false,
          -- THE CHANGE: a locked final bet with no answer under it is lost.
          score_earned     = CASE
                               WHEN is_final
                                    AND btrim(coalesce(answers.submitted_answer, '')) = '__WAGER_LOCKED__'
                                 THEN -COALESCE(answers.wager, 0)
                               ELSE 0
                             END
      WHERE btrim(coalesce(answers.submitted_answer, '')) = '__WAGER_LOCKED__'
         OR (answers.question_id IS NOT NULL
             AND answers.question_id IS DISTINCT FROM EXCLUDED.question_id);
    IF FOUND THEN written := written + 1; END IF;
  END LOOP;

  RETURN written;
END;
$$;

GRANT EXECUTE ON FUNCTION op_fill_blank_answers(uuid, int) TO anon, authenticated;

-- ============================================
-- VERIFICATION — one row per rule; read the verdict column.
-- ============================================
SELECT * FROM (
  SELECT 1 AS ord, 'op_fill_blank_answers installed' AS thing,
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — no round can close itself' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers'), 'MISSING') AS verdict

  UNION ALL SELECT 2, 'a blank final answer loses the locked bet',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%-COALESCE(answers.wager, 0)%'
      THEN 'ok' ELSE 'FAIL the old version is still installed' END

  UNION ALL SELECT 3, 'it still knows about a leftover row (066)',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%IS DISTINCT FROM EXCLUDED.question_id%'
      THEN 'ok' ELSE 'FAIL' END
) report ORDER BY ord;
