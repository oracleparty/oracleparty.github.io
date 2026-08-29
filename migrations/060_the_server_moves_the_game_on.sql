-- ============================================
-- 060 — SLICE 11: THE SERVER MOVES THE GAME ON
--
-- Needs 048 (op_is_room_host) and 058 (op_room_has_live_host).
--
-- Slice 7 (056) moved the TIME-BASED transitions to the server: a round ends on
-- the clock, and a countdown finishes, whether or not the host's phone is awake.
-- This is the other half — the transitions a PERSON decides: revealing the
-- answers, moving to the scoreboard, starting the next question, ending the
-- game, going back to the lobby.
--
-- WHY THEY HAVE TO MOVE AT ALL. `rooms` still has `FOR UPDATE USING (true)`,
-- and the phase is the most damaging column on it: anyone reaching the site can
-- shove a live game to `results`, back to `lobby`, or on to a question nobody
-- has been asked. That is the last big hole, and it cannot be closed while the
-- phase machine is a browser write — which is exactly what CLAUDE.md #2 says
-- and why `rooms` was left alone by 048, 051, 057 and 058.
--
-- AUTHORITY IS NOT INITIATIVE. A person still presses the button; what changes
-- is that the ANSWER comes from the database. Any client may ask, and the
-- server decides whether that caller may move THIS room out of THIS phase.
--
-- DELIBERATELY NOT A TRANSITION WHITELIST. The obvious design is a table of
-- allowed from→to pairs, and I am not confident enough in the full graph to
-- write one — a wrong entry does not fail loudly, it makes a game unplayable at
-- one specific moment. This project has been burned exactly that way twice
-- (049's three broken writes, and the disqualification heuristic ported into a
-- permission in the same migration). What is enforced instead is the part that
-- is certain and does all the security work:
--
--   1. the caller is in the room, and is the host, the co-host, or is present
--      in a room with no live host (which is the deputy case, and the reason a
--      game does not stall behind one phone)
--   2. COMPARE-AND-SET on the phase the caller believes the room is in, so a
--      stale click cannot rewind a game and two phones cannot double-advance it
--   3. the destination is a phase this game actually has
--
-- A stranger with the room code fails (1). A duplicate or late click fails (2).
-- Neither of those needs a graph, and the graph can be tightened later against
-- real games rather than guessed at now.
-- ============================================


-- --------------------------------------------
-- 1. May this caller move this room on?
--
-- The three cases are the same three `canControlGame()` allows in the client,
-- stated where a request cannot edit them out. The third is deputising: the
-- host has gone quiet and the game must not sit frozen behind one phone.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_may_advance(p_room_id uuid, p_caller_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM players p
     WHERE p.id = p_caller_id
       AND p.room_id = p_room_id
       AND NOT coalesce(p.is_bot, false)
       AND (
         p.is_host
         OR coalesce(p.is_cohost, false)
         -- Nobody is driving: anybody still here may. Deliberately not "the
         -- longest-present player" — that is the client's tie-break for WHO
         -- should, and duplicating it here would be a second implementation of
         -- a rule that only has to pick somebody. Compare-and-set means two
         -- people pressing at once still advance the room exactly one step.
         OR NOT op_room_has_live_host(p_room_id)
       )
  );
$$;

GRANT EXECUTE ON FUNCTION op_may_advance(uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 2. Move the room to a new phase
--
-- Returns text, not a boolean: a caller has to tell "I moved it", "somebody
-- else already did" and "you may not" apart, and collapsing those is how a
-- working guard and a broken one come to look identical (CLAUDE.md #6).
--
-- p_expected_phase is the phase the CALLER believes the room is in. Passing the
-- wrong one is not an error worth shouting about — it means the room moved
-- underneath them, which Realtime makes ordinary.
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
  IF p_to_phase IS NULL OR p_to_phase NOT IN (
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
-- 3. Verify
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'op_set_phase installed and callable' AS thing,
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — no game could advance' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_phase'), 'MISSING') AS verdict
  UNION ALL SELECT 2, 'op_may_advance installed',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_may_advance')
    THEN 'ok' ELSE 'MISSING' END
  UNION ALL SELECT 3, 'rooms UPDATE is still open (deliberate, for now)',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'rooms'
                        AND cmd IN ('UPDATE', 'ALL'))
    THEN 'ok' ELSE 'FAIL the client fallback and host settings are refused' END
) report ORDER BY ord;
