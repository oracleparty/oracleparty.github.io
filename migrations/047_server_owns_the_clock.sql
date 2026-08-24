-- ============================================
-- 047 — THE SERVER OWNS THE CLOCK
--
-- Needs 045 and 046.
--
-- `question_started_at` is what every timer in the game is derived from. Today
-- the host's browser computes it as `Date.now() + serverTimeOffset` — an
-- ESTIMATE of what the server's clock says — and writes that.
--
-- That was self-consistent while nothing but browsers read it: every phone
-- reads the same stamp, so a skewed estimate skewed everybody equally and
-- nobody could tell. Migration 046 ended that. `op_submit_answer` now compares
-- the stamp against the DATABASE's `now()`, so a host whose estimate runs slow
-- would have every answer in the room refused as late, and a host whose
-- estimate runs fast would have the timer never expire at all.
--
-- **This is a hazard introduced by 046, and it is fixed here rather than
-- guarded around.** The stamp comes from `now()` — the same clock the check
-- uses — so the two cannot disagree by construction.
--
-- It replaces a write the client already makes, so it costs no extra round
-- trip, and it stays host-gated on the client exactly as before. Who may start
-- a round is a separate question from whose clock is used, and only the second
-- one is being answered here.
-- ============================================


-- --------------------------------------------
-- op_start_clock — stamp the round's start with the database's own time
--
-- The phase and question the caller believes it is starting are passed in and
-- CHECKED. A host that has fallen behind — a slow network, a screen that woke
-- up late — would otherwise stamp a round the room has already left, resetting
-- a timer everybody else is already partway through.
--
-- Returns the stamp actually in force, whether or not this call set it, so the
-- caller always has the same value every other phone is reading rather than a
-- guess about whether it won.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_start_clock(
  p_room_id uuid,
  p_phase text,
  p_question_number int DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ts timestamptz;
BEGIN
  UPDATE rooms
     SET question_started_at = now()
   WHERE id = p_room_id
     AND game_phase = p_phase
     AND (p_question_number IS NULL OR current_question = p_question_number)
  RETURNING question_started_at INTO ts;

  -- NOTHING STAMPED MEANS NULL, and the first version returned the stamp that
  -- was already on the room instead. That reads well and is badly wrong: the
  -- caller cannot tell "here is your round's clock" from "here is the LAST
  -- round's clock", so it adopted a timestamp thirty seconds old as the start
  -- of a round just beginning. The final wager is twenty seconds long, so the
  -- host's clock was expired before the screen appeared and locked them at a
  -- wager of 0 with no chance to choose. Found in a live game.
  --
  -- NULL sends the caller to its own estimate, which is what it did for months
  -- before this function existed and is self-consistent. Losing the guard on a
  -- refused call is a far smaller price than handing back a clock that has
  -- already run out.
  RETURN ts;
END;
$$;


-- --------------------------------------------
-- op_server_now — what time does the database think it is
--
-- A fallback for any client that still needs to compute a stamp itself, and
-- the honest way to measure `serverTimeOffset` rather than inferring it from
-- response headers. Cheap, read-only, and safe for anyone to call.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_server_now()
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public
AS $$ SELECT now(); $$;


GRANT EXECUTE ON FUNCTION op_start_clock(uuid, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_server_now()                 TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT
  CASE WHEN to_regprocedure('op_start_clock(uuid,text,int)') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_start_clock missing' END AS start_clock,
  CASE WHEN to_regprocedure('op_server_now()') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_server_now missing' END  AS server_now,
  CASE WHEN has_function_privilege('anon', 'op_start_clock(uuid,text,int)', 'EXECUTE')
       THEN 'ok' ELSE 'FAIL players cannot call it' END AS guests_may_call;
