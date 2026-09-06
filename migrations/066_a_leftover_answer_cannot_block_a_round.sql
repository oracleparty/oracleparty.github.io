-- ============================================
-- 066 — a row left over from a finished game must not block this one
--
-- THE HOLE, and it was made by a fix rather than by an omission.
--
-- A room survives Play Again, and the clear-out that deletes the previous
-- game's answers is HOST-GATED — so a room that goes back to the lobby without
-- its host keeps them. `answersForCurrentGame` in js/game/scoring-helpers.js
-- was added for exactly that: it refuses any answer whose `question_id` is not
-- the one the room is asking at that round number, which stopped last game's
-- points being counted again in this one.
--
-- That fixed the score and created something worse. The leftover row still
-- occupies (room_id, player_id, question_number) — the key the blank fill
-- conflicts on — and the fill only converts a `__WAGER_LOCKED__` placeholder.
-- So the row is INVISIBLE to the client and UNFILLABLE by the server, and the
-- player has no answer for the round at all: "Waiting..." for ever, and a
-- score of nothing. Reported from a live game as exactly that.
--
-- WHAT CHANGES: the fill also converts a row that names a DIFFERENT question
-- from the one this round is asking. Such a row belongs to a game that no
-- longer exists — the client has already decided it is not an answer — so
-- writing a blank over it is the only way that player gets a row for THIS
-- round, and it takes the stale points with it.
--
-- THREE THINGS IT DELIBERATELY DOES NOT TOUCH:
--   * a real answer to THIS round — the question_id matches, so the WHERE
--     misses it. That is the race that once destroyed answers people had typed
--     and it stays closed.
--   * a row with a NULL question_id. The client KEEPS those (it cannot tell
--     which game they belong to, and dropping a real answer costs somebody
--     their score), so they are visible and must not be overwritten.
--   * the `__WAGER_LOCKED__` rule, which is unchanged and still needed: that
--     row names the right question and still is not an answer.
--
-- Verified against a real Postgres. Before: 3 of 207 rules fail, including
-- "a leftover row from the last game is filled, not skipped". After: all hold,
-- and "a real answer to THIS round is still never overwritten" holds both ways.
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

  -- EVERY player, with the protection expressed ONCE, in the ON CONFLICT below.
  -- Pre-filtering to "people who have not answered" is what made the earlier
  -- ON CONFLICT guard sit behind a condition that already excluded the only
  -- case it defends — a guard behind a guard is not twice as safe, it is
  -- untestable.
  FOR p IN SELECT * FROM players WHERE room_id = p_room_id LOOP
    INSERT INTO answers (room_id, player_id, question_number, question_id,
                         wager, submitted_answer, is_correct, auto_correct, score_earned)
    VALUES (p_room_id, p.id, p_question_number, qid,
            CASE WHEN is_final THEN 0 ELSE op_next_wager(p_room_id, p.id, total) END,
            '', false, false, 0)
    ON CONFLICT (room_id, player_id, question_number) DO UPDATE
      SET submitted_answer = '',
          wager            = CASE
                               -- Locked is locked: a final wager already on the
                               -- row survives, and what a blank COSTS is said in
                               -- score_earned. Zeroing it here is the "I bet 20
                               -- and it wagered 0" bug migration 050 fixed.
                               WHEN answers.question_id IS DISTINCT FROM EXCLUDED.question_id
                                    AND answers.question_id IS NOT NULL
                                 THEN EXCLUDED.wager
                               ELSE COALESCE(answers.wager, EXCLUDED.wager)
                             END,
          -- A leftover row named the wrong question. It names this one now, or
          -- the client would go on filtering out the blank we just wrote.
          question_id      = EXCLUDED.question_id,
          is_correct       = false,
          auto_correct     = false,
          score_earned     = 0
      WHERE btrim(coalesce(answers.submitted_answer, '')) = '__WAGER_LOCKED__'
         -- A row from a game this room has already finished. See the header.
         OR (answers.question_id IS NOT NULL
             AND answers.question_id IS DISTINCT FROM EXCLUDED.question_id);
    IF FOUND THEN written := written + 1; END IF;
  END LOOP;

  RETURN written;
END;
$$;

GRANT EXECUTE ON FUNCTION op_fill_blank_answers(uuid, int) TO anon, authenticated;

-- ============================================
-- VERIFICATION — paste this and read the verdicts.
-- ============================================
SELECT * FROM (
  SELECT 1 AS ord, 'op_fill_blank_answers installed' AS thing,
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — no round can close itself' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers'), 'MISSING') AS verdict

  UNION ALL SELECT 2, 'it knows about a leftover row',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%IS DISTINCT FROM EXCLUDED.question_id%'
      THEN 'ok' ELSE 'FAIL the old version is still installed' END

  UNION ALL SELECT 3, 'it still protects a real answer',
    CASE WHEN (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
              LIKE '%__WAGER_LOCKED__%'
      THEN 'ok' ELSE 'FAIL the placeholder rule went missing' END
) report ORDER BY ord;
