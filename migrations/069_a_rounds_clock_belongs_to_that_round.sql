-- ============================================
-- 069 — A ROUND'S CLOCK BELONGS TO THAT ROUND, AND NO ROUND IS SKIPPED
--
-- Two rules, both about op_set_phase, both from the same live game.
--
-- ---------------------------------------------------------------------------
-- 1. THE CLOCK
--
-- Reported: "one of the questions only seconds in advanced us without allowing
-- us to type answers. It just said waiting." Photographed: the reveal screen on
-- question 9 of 15 with every human reading "Waiting…".
--
-- `rooms.question_started_at` is what every timer in the game derives from, and
-- op_advance_deadline() (056) is `question_started_at + question_timer + 8s`.
-- So a room that announces round N+1 while still holding round N's stamp has a
-- deadline that is ALREADY IN THE PAST, and the first phone whose backstop
-- polls ends the round on the spot. Nobody typed anything; everybody is filled
-- in blank.
--
-- Until now the only thing clearing that stamp was a separate, FIRE-AND-FORGET
-- write from the presser's phone (`handleNextQuestion` in js/game/reveal.js),
-- issued just before the phase write and racing it. Two requests, no ordering
-- between them. Lose the race and the room sits in exactly the state above.
--
-- The client now awaits that write, which narrows the window. THIS closes it:
-- moving INTO a round and clearing that round's clock become one statement, so
-- there is no window at all. It cannot be lost, reordered or dropped.
--
-- ONLY ON ENTRY TO A DIFFERENT ROUND. Re-announcing the phase and question the
-- room is already on must not wipe a clock that is legitimately running — a
-- repeated call is ordinary here (Realtime re-delivery, two controllers), and
-- the whole point of 056's idempotence is that a repeat costs nothing.
--
-- ---------------------------------------------------------------------------
-- 2. NO ROUND IS SKIPPED
--
-- Reported: "question 2 was skipped entirely."
--
-- "Next Question" reads the client's current round number, adds one, and sends
-- that. Nothing disabled the button and nothing latched the handler, so a
-- second tap landing inside the ~500ms screen fade read the number the first
-- tap had already raised and announced N+2. No question, no answer row, one
-- wager left unspent for the rest of the game.
--
-- Both client guards are in (a re-entry latch, and a record of which round was
-- advanced out of), and this is the backstop for the case they cannot see: two
-- different phones. A game never jumps a round, so a call naming a number more
-- than one past the room's own is refused.
--
-- DELIBERATELY NOT A TRANSITION WHITELIST. CLAUDE.md records two attempts at a
-- phase graph, one flat and one per-round, and each made the game unplayable at
-- one specific moment. This is a single arithmetic fact about ONE destination —
-- the round number rises by one — and it says nothing about which phases may
-- follow which.
--
-- Play Again and Start Game both send question 0 with a phase of 'lobby' or
-- NULL and are unaffected; going BACKWARDS is untouched, because that is how a
-- room is reset.
--
-- ---------------------------------------------------------------------------
-- SAFE TO APPLY WITH THE CURRENT JAVASCRIPT ALREADY LIVE, and the JavaScript is
-- safe without this: the client clears the clock itself and latches its own
-- button. This makes both true by construction instead of by timing.
-- ============================================


CREATE OR REPLACE FUNCTION op_set_phase(
  p_room_id        uuid,
  p_caller_id      uuid,
  p_expected_phase text,
  p_to_phase       text,
  p_question       int DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  moved int;
BEGIN
  -- NULL MEANS "CLEAR THE PHASE", which is a real state this app uses and which
  -- migration 061 taught this function to express. Rebuilding it from 060's
  -- body would have taken that away again and stopped every game starting —
  -- caught by tests/sql/game-rules.sql, which is what that table is for.
  IF p_to_phase IS NOT NULL AND p_to_phase NOT IN (
    'lobby', 'countdown', 'question', 'reveal', 'answer_reveal',
    'scores_reveal', 'final_wager', 'final_question', 'results'
  ) THEN
    RETURN 'not a phase';
  END IF;

  IF NOT op_may_advance(p_room_id, p_caller_id) THEN
    RETURN 'not allowed';
  END IF;

  -- A GAME NEVER JUMPS A ROUND. See note 2 above.
  IF p_question IS NOT NULL AND EXISTS (
       SELECT 1 FROM rooms
        WHERE id = p_room_id
          AND p_question > coalesce(current_question, 0) + 1
     ) THEN
    RETURN 'skips a round';
  END IF;

  UPDATE rooms
     SET game_phase = p_to_phase,
         current_question = COALESCE(p_question, current_question),
         -- THE ROUND'S CLOCK, CLEARED IN THE SAME STATEMENT. See note 1 above.
         -- Only when this call actually moves the room into a DIFFERENT round;
         -- re-announcing the round it is already on leaves a running clock
         -- alone.
         question_started_at = CASE
           WHEN p_to_phase IN ('question', 'final_question')
                AND (game_phase IS DISTINCT FROM p_to_phase
                     OR current_question IS DISTINCT FROM COALESCE(p_question, current_question))
             THEN NULL
           ELSE question_started_at
         END
   WHERE id = p_room_id
     -- COMPARE-AND-SET. A stale click cannot rewind a game, and two phones
     -- pressing at once move it exactly one step: the second matches nothing.
     -- `IS NOT DISTINCT FROM` so a room whose phase is NULL can still be
     -- started — Play Again sets it null, and `= NULL` would never match.
     AND (p_expected_phase IS NULL OR game_phase IS NOT DISTINCT FROM p_expected_phase);
  GET DIAGNOSTICS moved = ROW_COUNT;

  RETURN CASE WHEN moved > 0 THEN 'ok' ELSE 'already moved' END;
END;
$$;

GRANT EXECUTE ON FUNCTION op_set_phase(uuid, uuid, text, text, int) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — reads the installed function's own source, so a paste that stopped
-- halfway cannot report ok. Every cell must read "ok".
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'op_set_phase installed and callable' AS thing,
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'FAIL not callable — no game could advance' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'FAIL missing') AS verdict

  UNION ALL SELECT 2, 'entering a new round clears that round''s clock',
    COALESCE((SELECT CASE WHEN p.prosrc LIKE '%question_started_at = CASE%'
                           AND p.prosrc LIKE '%game_phase IS DISTINCT FROM p_to_phase%'
                          THEN 'ok' ELSE 'FAIL a round can still open on the last one''s clock' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'FAIL missing')

  UNION ALL SELECT 3, 'a round cannot be skipped',
    COALESCE((SELECT CASE WHEN p.prosrc LIKE '%skips a round%'
                          THEN 'ok' ELSE 'FAIL a double press can still jump a question' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'FAIL missing')

  UNION ALL SELECT 4, 'it still runs with the owner''s rights',
    COALESCE((SELECT CASE WHEN p.prosecdef THEN 'ok'
                          ELSE 'FAIL not SECURITY DEFINER — RLS would refuse it' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'FAIL missing')

  UNION ALL SELECT 5, 'and still checks who is asking',
    COALESCE((SELECT CASE WHEN p.prosrc LIKE '%op_may_advance%'
                          THEN 'ok' ELSE 'FAIL anybody could move the game on' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'FAIL missing')
) v ORDER BY ord;
