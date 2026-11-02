-- ============================================
-- 080 — the final question gets 15 more seconds (owner, 2026-11-02)
--
-- "Can we add 15 seconds to all final questions?" The final round is the only
-- one that subtracts, and people take longer over it.
--
-- The length of a round was written inline in two places — op_submit_answer's
-- late check (046) and op_advance_deadline (056). op_round_seconds(r) is the
-- one rule now, and both read it, so the screen's clock (js:
-- roundTimerSeconds in js/game/state.js, FINAL_QUESTION_EXTRA_SECONDS) and
-- the server's can only disagree if this and that constant do.
--
-- op_submit_answer below is 046's body with one expression changed; nothing
-- else in it moved.
-- ============================================

CREATE OR REPLACE FUNCTION op_round_seconds(r rooms)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(r.question_timer, 30)
       + CASE WHEN r.game_phase = 'final_question' THEN 15 ELSE 0 END;
$$;

GRANT EXECUTE ON FUNCTION op_round_seconds(rooms) TO anon, authenticated;

CREATE OR REPLACE FUNCTION op_advance_deadline(r rooms)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT r.question_started_at
       + make_interval(secs => op_round_seconds(r))
       + interval '8 seconds';
$$;

CREATE OR REPLACE FUNCTION op_submit_answer(
  p_room_id uuid,
  p_player_id uuid,
  p_question_number int,
  p_answer text,
  p_wager int DEFAULT NULL
)
RETURNS TABLE (is_correct boolean, score_earned int, wager int, question_id uuid, rejected text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r rooms;
  total int;
  is_final boolean;
  qid uuid;
  q questions;
  verdict boolean;
  chosen int;
  earned int;
  deadline timestamptz;
  existing answers;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, NULL::int, NULL::uuid, 'no such room'::text; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM players WHERE id = p_player_id AND room_id = p_room_id) THEN
    RETURN QUERY SELECT false, 0, NULL::int, NULL::uuid, 'not in this room'::text; RETURN;
  END IF;

  total := op_room_total_questions(r);
  is_final := p_question_number >= total;

  -- You may only answer the question that is on screen. Today any client can
  -- write an answer for a round that has not happened yet.
  IF p_question_number <> r.current_question THEN
    RETURN QUERY SELECT false, 0, NULL::int, NULL::uuid, 'not the current question'::text; RETURN;
  END IF;

  -- ...and only while it is open. TIMER_GRACE_MS in js/constants.js is 500ms;
  -- the allowance here is deliberately far larger, because this is the clock
  -- for a person on a phone with a bad connection, not a countdown animation.
  -- Refusing an answer that was typed in time would be a far worse bug than
  -- accepting one typed a second late.
  IF r.question_started_at IS NOT NULL THEN
    deadline := r.question_started_at
      + make_interval(secs => op_round_seconds(r))
      + interval '3 seconds';
    IF now() > deadline THEN
      RETURN QUERY SELECT false, 0, NULL::int, NULL::uuid, 'time is up'::text; RETURN;
    END IF;
  END IF;

  qid := r.question_ids[p_question_number + 1];   -- Postgres arrays are 1-based
  SELECT * INTO q FROM questions WHERE id = qid;

  -- A blank is a blank whatever the key says, and a question the room cannot
  -- find is not something to mark anybody wrong OR right for.
  IF q.id IS NULL OR btrim(coalesce(p_answer, '')) = '' THEN
    verdict := false;
  ELSE
    verdict := op_answer_matches(p_answer, q.correct_answer, q.acceptable_answers);
  END IF;

  SELECT * INTO existing FROM answers
   WHERE room_id = p_room_id AND player_id = p_player_id AND question_number = p_question_number;

  IF is_final AND existing.wager IS NOT NULL THEN
    -- Locked is locked. The final wager is committed before the question is
    -- shown, so once it is on the row it cannot be revised by the answer that
    -- follows it — which is the whole point of committing it first.
    chosen := existing.wager;
  ELSIF is_final THEN
    -- 0, 10 or 20, and nothing else. The client offers three buttons; this is
    -- what stops a request offering 500.
    chosen := coalesce(p_wager, 0);
    IF chosen NOT IN (0, 10, 20) THEN chosen := 0; END IF;
  ELSIF existing.wager IS NOT NULL THEN
    -- Already committed this round. The wager cannot be changed by re-editing
    -- an answer, which is how one value could be spent twice.
    chosen := existing.wager;
  ELSE
    chosen := p_wager;
    -- Out of range, already spent, or not offered at all: take the lowest they
    -- genuinely still hold. Refusing outright would cost somebody a round over
    -- a stale screen.
    IF chosen IS NULL OR chosen < 1 OR chosen > total
       OR EXISTS (
         SELECT 1 FROM answers a
         WHERE a.room_id = p_room_id AND a.player_id = p_player_id
           AND a.question_number < total AND a.wager = chosen
           AND btrim(coalesce(a.submitted_answer, '')) <> '__WAGER_LOCKED__')
    THEN
      chosen := op_next_wager(p_room_id, p_player_id, total);
    END IF;
  END IF;

  -- computeScoreEarned: the final round is the only one that subtracts.
  earned := CASE WHEN verdict THEN chosen
                 WHEN is_final THEN -chosen
                 ELSE 0 END;

  INSERT INTO answers (room_id, player_id, question_number, question_id,
                       wager, submitted_answer, is_correct, auto_correct, score_earned)
  VALUES (p_room_id, p_player_id, p_question_number, qid,
          chosen, coalesce(p_answer, ''), verdict, verdict, earned)
  ON CONFLICT (room_id, player_id, question_number) DO UPDATE
    SET submitted_answer = EXCLUDED.submitted_answer,
        question_id      = EXCLUDED.question_id,
        wager            = EXCLUDED.wager,
        is_correct       = EXCLUDED.is_correct,
        -- auto_correct is the MACHINE's verdict and is what a host override is
        -- later compared against, so it tracks the machine here too. It stops
        -- moving the moment a human overrules it, which happens elsewhere.
        auto_correct     = EXCLUDED.auto_correct,
        score_earned     = EXCLUDED.score_earned;

  RETURN QUERY SELECT verdict, earned, chosen, qid, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION op_submit_answer(uuid, uuid, int, text, int) TO anon, authenticated;

-- ============================================
-- VERIFICATION — one row per rule; read the verdict column.
-- ============================================
SELECT * FROM (
  SELECT 1 AS ord, 'op_round_seconds installed' AS thing,
    CASE WHEN to_regprocedure('public.op_round_seconds(rooms)') IS NOT NULL
      THEN 'ok' ELSE 'MISSING' END AS verdict
  UNION ALL SELECT 2, 'answers are accepted for the longer final round',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_submit_answer')
              LIKE '%op_round_seconds%'
      THEN 'ok' ELSE 'FAIL op_submit_answer still uses the old clock' END
  UNION ALL SELECT 3, 'the backstop waits for the longer final round',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_advance_deadline')
              LIKE '%op_round_seconds%'
      THEN 'ok' ELSE 'FAIL' END
) report ORDER BY ord;
