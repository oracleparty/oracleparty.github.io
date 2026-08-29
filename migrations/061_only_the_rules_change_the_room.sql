-- ============================================
-- 061 — SLICE 12: ONLY THE RULES CHANGE THE ROOM
--
-- Needs 060.
--
-- THE LAST BIG HOLE. `rooms` has `FOR UPDATE USING (true)`, and the two most
-- damaging columns on it are `game_phase` and `current_question`: anyone
-- reaching the site could shove a live game to `results`, back to `lobby`, or
-- on to a question nobody has been asked. Slice 11 put every phase write in
-- `js/` behind op_set_phase; this is the door that makes that worth anything.
--
-- COLUMN GRANTS AGAIN, the mechanism 058 established and measured: Postgres
-- enforces column privileges independently of RLS, so revoking the table-wide
-- UPDATE and re-granting the rest leaves `game_phase` unwritable while every
-- other room write carries on untouched. The UPDATE policy stays `USING (true)`
-- — asserting the policy would prove nothing, so the check asserts
-- `has_column_privilege`.
--
-- WHAT A CLIENT MAY STILL WRITE, and why each has to stay:
--
--   question_ids, used_question_ids   question selection runs in the browser
--   countdown_started_at              written with the question list at start
--   question_started_at               op_start_clock (047) owns this, but its
--                                     fallback still needs it, and the lobby's
--                                     pre-start reset clears it. A LESSER HOLE
--                                     LEFT OPEN DELIBERATELY — see below.
--   room_scores                       the host's running tally
--   host_name                         follows promotion
--   status                            lobby / playing
--   category, subcategory, who_can_join, questions_per_game, question_timer,
--   auto_proceed                      the host's settings
--
-- WHAT THIS DOES NOT DO. `question_started_at` stays writable, so somebody
-- could still reset a round's clock. That is a nuisance, not a takeover, and
-- closing it means moving the lobby's pre-start reset behind a function too —
-- its own slice, enumerated rather than discovered.
--
-- EVERY WRITE TO `rooms` IN `js/` WAS ENUMERATED FIRST (049's lesson). Four
-- were writing `current_question` redundantly alongside a phase change that
-- already carried it, and one — the lobby's pre-start reset — clears the phase
-- to NULL, which op_set_phase could not express. Hence part 1.
-- ============================================


-- --------------------------------------------
-- 1. A phase can be CLEARED, not only set
--
-- The lobby's pre-start reset writes `game_phase = NULL` before flipping the
-- room to `playing`, so the room is never simultaneously "playing" and phase
-- "lobby". NULL is not interchangeable with 'lobby' here: syncToCurrentState
-- returns early on a falsy phase, and handleRoomChange skips the transition
-- entirely — so quietly substituting 'lobby' would change what every client
-- does during that window. Better to let the function say what the app means.
-- --------------------------------------------
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
  -- NULL now means "clear the phase", which is a real state this app uses.
  -- Anything else must still be a phase the game actually has.
  IF p_to_phase IS NOT NULL AND p_to_phase NOT IN (
    'lobby', 'countdown', 'question', 'reveal', 'answer_reveal',
    'scores_reveal', 'final_wager', 'final_question', 'results'
  ) THEN
    RETURN 'not a phase';
  END IF;

  IF NOT op_may_advance(p_room_id, p_caller_id) THEN
    RETURN 'not allowed';
  END IF;

  UPDATE rooms
     SET game_phase = p_to_phase,
         current_question = COALESCE(p_question, current_question)
   WHERE id = p_room_id
     AND (p_expected_phase IS NULL OR game_phase IS NOT DISTINCT FROM p_expected_phase);
  GET DIAGNOSTICS moved = ROW_COUNT;

  RETURN CASE WHEN moved > 0 THEN 'ok' ELSE 'already moved' END;
END;
$$;

GRANT EXECUTE ON FUNCTION op_set_phase(uuid, uuid, text, text, int) TO anon, authenticated;


-- --------------------------------------------
-- 2. Narrow what a client may write
--
-- Everything EXCEPT game_phase and current_question. Listed explicitly rather
-- than "all but two", because a column added later must be a deliberate
-- decision about who may write it, not an accident of syntax.
-- --------------------------------------------
REVOKE UPDATE ON rooms FROM anon, authenticated;
GRANT UPDATE (
  question_ids, used_question_ids,
  question_started_at, countdown_started_at,
  room_scores, host_name, status,
  category, subcategory, who_can_join,
  questions_per_game, question_timer, auto_proceed
) ON rooms TO anon, authenticated;


-- --------------------------------------------
-- 3. Verify
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'nobody can write the game phase directly' AS thing,
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'game_phase', 'UPDATE')
    THEN 'FAIL anyone can still end or rewind a live game' ELSE 'ok' END AS verdict

  UNION ALL SELECT 2, 'nor skip to another question',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'current_question', 'UPDATE')
    THEN 'FAIL' ELSE 'ok' END

  UNION ALL SELECT 3, 'question selection still works',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'question_ids', 'UPDATE')
    THEN 'ok' ELSE 'FAIL no game can choose its questions' END

  UNION ALL SELECT 4, 'the round clock still works',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'question_started_at', 'UPDATE')
    THEN 'ok' ELSE 'FAIL no timer can start' END

  UNION ALL SELECT 5, 'the countdown still works',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'countdown_started_at', 'UPDATE')
    THEN 'ok' ELSE 'FAIL no game can be started' END

  UNION ALL SELECT 6, 'host settings still work',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'question_timer', 'UPDATE')
     AND has_column_privilege('anon', 'public.rooms', 'who_can_join', 'UPDATE')
    THEN 'ok' ELSE 'FAIL the host settings panel is refused' END

  UNION ALL SELECT 7, 'the room tally still works',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'room_scores', 'UPDATE')
    THEN 'ok' ELSE 'FAIL Room Scores stop accumulating' END

  UNION ALL SELECT 8, 'lobby / playing still works',
    CASE WHEN has_column_privilege('anon', 'public.rooms', 'status', 'UPDATE')
    THEN 'ok' ELSE 'FAIL no game can start or end' END

  UNION ALL SELECT 9, 'op_set_phase can clear a phase',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_set_phase')
    THEN 'ok' ELSE 'MISSING' END
) report ORDER BY ord;

SELECT string_agg(column_name, ', ' ORDER BY column_name) AS a_client_may_write
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'rooms'
  AND grantee = 'anon' AND privilege_type = 'UPDATE';
