-- ============================================
-- 081 — what somebody has typed is kept as a DRAFT (owner, 2026-11-05)
--
-- Reported: a friend's answer read "No answer" though they had typed one.
-- Every phone sends what is typed when its timer runs out, but the server only
-- takes answers until `timer + 3s`, and the live database has been measured
-- answering in up to 3.9s. A last-moment send that arrives after the cut-off
-- is refused, and the blank the fill wrote stands.
--
-- The owner's fix: while somebody types, their phone quietly keeps a copy of
-- the text on the server, marked NOT SUBMITTED. If no real answer has arrived
-- by the time the round is closed, the fill uses that copy instead of a blank.
--
-- WHY A SEPARATE TABLE, and not an answer row. An answer row is an answer:
--   * op_submit_answer keeps `existing.wager` once a row exists, so a draft
--     written there would LOCK the bet the player can still change;
--   * every phone counts rows to decide who is still answering, so a draft
--     there would show somebody as answered while they are still typing.
-- answer_drafts is read by NOTHING but the fill below. No client may read or
-- write it directly; op_save_draft is the only way in.
--
-- WHAT THE FILL DOES WITH IT, and does not:
--   * a real answer to this round still stands — the WHERE is 066's, unchanged;
--   * a draft is judged exactly like a submitted answer (op_answer_matches) and
--     scored by the same rule: right earns the wager, wrong earns nothing,
--     except on the final round, which takes the wager;
--   * a regular round's draft carries the bet the screen had selected, or the
--     lowest unspent one if that is spent or off the menu (046's rule);
--   * on the final round the LOCKED bet is used, whatever the draft says;
--   * no draft, or an empty one, is a blank exactly as 079 scores it.
--   * a draft is only used for the question the room is asking NOW and only if
--     it was saved during this round — Play Again keeps the room, and a draft
--     from the last game must not answer this one.
-- ============================================

CREATE TABLE IF NOT EXISTS answer_drafts (
  room_id          uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id        uuid NOT NULL,
  question_number  int  NOT NULL,
  question_id      uuid,
  answer_text      text NOT NULL DEFAULT '',
  wager            int,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, player_id, question_number)
);

ALTER TABLE answer_drafts ENABLE ROW LEVEL SECURITY;
-- Supabase grants every new table to anon and authenticated by default
-- (CLAUDE.md, "A new table arrives already granted to everybody"). A GRANT
-- adds and never subtracts; only this removes what nobody asked for.
REVOKE ALL ON answer_drafts FROM anon, authenticated;

-- ---- saving a draft --------------------------------------------------------
-- Returns 'saved', or why not. Refuses exactly what op_submit_answer refuses
-- (not in the room, not this round, past the deadline), so a draft can never
-- reach a round an answer could not.
CREATE OR REPLACE FUNCTION op_save_draft(
  p_room_id uuid,
  p_player_id uuid,
  p_question_number int,
  p_answer text,
  p_wager int DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r rooms;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF r.id IS NULL THEN RETURN 'no such room'; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = p_player_id AND room_id = p_room_id) THEN
    RETURN 'not in this room';
  END IF;
  IF p_question_number <> r.current_question THEN RETURN 'not the current question'; END IF;
  IF r.game_phase NOT IN ('question', 'final_question') THEN RETURN 'round is over'; END IF;
  IF r.question_started_at IS NOT NULL
     AND now() > r.question_started_at + make_interval(secs => op_round_seconds(r)) + interval '3 seconds' THEN
    RETURN 'time is up';
  END IF;

  INSERT INTO answer_drafts (room_id, player_id, question_number, question_id, answer_text, wager, updated_at)
  VALUES (p_room_id, p_player_id, p_question_number,
          r.question_ids[p_question_number + 1], left(coalesce(p_answer, ''), 500), p_wager, now())
  ON CONFLICT (room_id, player_id, question_number) DO UPDATE
    SET question_id = EXCLUDED.question_id,
        answer_text = EXCLUDED.answer_text,
        wager       = EXCLUDED.wager,
        updated_at  = EXCLUDED.updated_at;
  RETURN 'saved';
END;
$$;

GRANT EXECUTE ON FUNCTION op_save_draft(uuid, uuid, int, text, int) TO anon, authenticated;

-- ---- the fill, now draft-aware ---------------------------------------------
-- 079's body, with the values for each player worked out first so a draft can
-- stand in for the blank. The ON CONFLICT ... WHERE is 066/079's, unchanged:
-- it is what stops the fill overwriting a real answer, whatever raced it.
CREATE OR REPLACE FUNCTION op_fill_blank_answers(p_room_id uuid, p_question_number int)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          rooms;
  p          players;
  q          questions;
  d          answer_drafts;
  qid        uuid;
  total      int;
  is_final   boolean;
  written    int := 0;
  has_draft  boolean;
  v_text     text;
  v_verdict  boolean;
  v_wager    int;
  v_score    int;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF r.id IS NULL THEN RETURN 0; END IF;

  total    := op_room_total_questions(r);
  is_final := (p_question_number >= total);
  qid      := r.question_ids[p_question_number + 1];   -- Postgres arrays are 1-based
  SELECT * INTO q FROM questions WHERE id = qid;

  FOR p IN SELECT * FROM players WHERE room_id = p_room_id LOOP
    d := NULL;
    SELECT * INTO d FROM answer_drafts
     WHERE room_id = p_room_id AND player_id = p.id AND question_number = p_question_number
       AND question_id IS NOT DISTINCT FROM qid
       AND (r.question_started_at IS NULL
            OR updated_at >= r.question_started_at - interval '10 seconds');
    has_draft := d.room_id IS NOT NULL AND btrim(coalesce(d.answer_text, '')) <> '';

    IF has_draft THEN
      v_text    := d.answer_text;
      v_verdict := q.id IS NOT NULL AND op_answer_matches(d.answer_text, q.correct_answer, q.acceptable_answers);
      IF is_final THEN
        v_wager := 0;   -- a locked bet on the row wins below (COALESCE)
      ELSE
        v_wager := d.wager;
        IF v_wager IS NULL OR v_wager < 1 OR v_wager > total
           OR EXISTS (
             SELECT 1 FROM answers a
              WHERE a.room_id = p_room_id AND a.player_id = p.id
                AND a.question_number < total AND a.question_number <> p_question_number
                AND a.wager = v_wager
                AND btrim(coalesce(a.submitted_answer, '')) <> '__WAGER_LOCKED__')
        THEN
          v_wager := op_next_wager(p_room_id, p.id, total);
        END IF;
      END IF;
    ELSE
      v_text    := '';
      v_verdict := false;
      v_wager   := CASE WHEN is_final THEN 0 ELSE op_next_wager(p_room_id, p.id, total) END;
    END IF;
    v_score := CASE WHEN v_verdict THEN v_wager
                    WHEN is_final THEN -v_wager
                    ELSE 0 END;

    INSERT INTO answers (room_id, player_id, question_number, question_id,
                         wager, submitted_answer, is_correct, auto_correct, score_earned)
    VALUES (p_room_id, p.id, p_question_number, qid,
            v_wager, v_text, v_verdict, v_verdict, v_score)
    ON CONFLICT (room_id, player_id, question_number) DO UPDATE
      SET submitted_answer = EXCLUDED.submitted_answer,
          wager            = CASE
                               WHEN answers.question_id IS DISTINCT FROM EXCLUDED.question_id
                                    AND answers.question_id IS NOT NULL
                                 THEN EXCLUDED.wager
                               ELSE COALESCE(answers.wager, EXCLUDED.wager)
                             END,
          question_id      = EXCLUDED.question_id,
          is_correct       = EXCLUDED.is_correct,
          auto_correct     = EXCLUDED.auto_correct,
          -- The wager expression again, because SET cannot read its own
          -- result. Right earns it; on the final round a locked bet with no
          -- right answer under it is lost (079), drafted or blank.
          score_earned     = CASE
                               WHEN EXCLUDED.is_correct THEN
                                 CASE WHEN answers.question_id IS DISTINCT FROM EXCLUDED.question_id
                                           AND answers.question_id IS NOT NULL
                                        THEN EXCLUDED.wager
                                      ELSE COALESCE(answers.wager, EXCLUDED.wager) END
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
  SELECT 1 AS ord, 'answer_drafts exists' AS thing,
    CASE WHEN to_regclass('public.answer_drafts') IS NOT NULL THEN 'ok' ELSE 'MISSING' END AS verdict

  UNION ALL SELECT 2, 'nobody can read or write drafts directly',
    CASE WHEN has_table_privilege('anon', 'public.answer_drafts', 'SELECT')
           OR has_table_privilege('anon', 'public.answer_drafts', 'INSERT')
           OR has_table_privilege('authenticated', 'public.answer_drafts', 'SELECT')
           OR has_table_privilege('authenticated', 'public.answer_drafts', 'INSERT')
      THEN 'FAIL drafts are exposed' ELSE 'ok' END

  UNION ALL SELECT 3, 'op_save_draft callable by players',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'ok' ELSE 'NOT CALLABLE' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_save_draft'), 'MISSING')

  UNION ALL SELECT 4, 'the fill reads drafts',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%answer_drafts%'
      THEN 'ok' ELSE 'FAIL the old fill is still installed' END

  UNION ALL SELECT 5, 'it still never overwrites a real answer (066)',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%IS DISTINCT FROM EXCLUDED.question_id);%'
      THEN 'ok' ELSE 'FAIL' END

  UNION ALL SELECT 6, 'a blank final answer still loses the locked bet (079)',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%-COALESCE(answers.wager, 0)%'
      THEN 'ok' ELSE 'FAIL' END
) report ORDER BY ord;
