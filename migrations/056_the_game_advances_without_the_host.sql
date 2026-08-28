-- ============================================
-- 056 — SLICE 7a: A ROUND ENDS WHETHER OR NOT THE HOST'S PHONE IS AWAKE
--
-- Needs 045–047 (op_room_total_questions, op_fill_blank_answers).
--
-- THE STALL, precisely. Every phase change in this game is a write from one
-- phone. `handleTimerExpiry` in js/game/question.js fills the blanks and sets
-- `game_phase = 'reveal'`, and the whole block is behind `canControlGame()` —
-- host, co-host, or a deputy. So when the host's screen locks mid-round, or
-- they take a call, or their signal drops, the timer runs out on every phone in
-- the room and NOTHING HAPPENS. Everyone sits on a dead question screen.
--
-- The deputy mechanism (HOST_HANDOVER_MS, 30s) already softens this, but it
-- depends on presence noticing, on somebody else being in the room, and on that
-- somebody's phone being awake. It is a mitigation, not a fix.
--
-- AUTHORITY IS NOT INITIATIVE. There is no application server here — Supabase
-- is Postgres, Realtime and Auth, and Postgres cannot wake itself on a timer.
-- So a client still has to ASK. What changes is that the ANSWER stops coming
-- from the asker: this function decides from the database's own clock, and
-- every client gets the same decision. Which is what makes it safe to let ANY
-- player in the room ask.
--
-- ONLY THE TIME-BASED TRANSITIONS MOVE HERE, and that boundary is deliberate:
--
--   countdown -> question    the countdown has finished
--   question  -> reveal      the timer has run out
--
-- Those need no human judgement — the clock already decided, and every phone is
-- merely reporting it. The rest of the flow (the host pressing "Reveal
-- Results", "Next Question", returning to the lobby) is a person making a
-- decision about when the room is ready to move on, and handing that to a timer
-- would change the game rather than repair it. Those stay where they are, with
-- the deputy covering an absent host.
--
-- THE SERVER IS A BACKSTOP, NOT A REPLACEMENT, and the deadline says so.
-- op_submit_answer accepts an answer until `started + timer + 3s`, deliberately
-- generous because that clock belongs to a person on a phone with a bad
-- connection. If this function closed the round at the same instant, an answer
-- the server would still have accepted could be turned into a blank by a race
-- nobody could see. So it waits ADVANCE_GRACE beyond the submit deadline —
-- comfortably after any answer that could still land, and long enough that a
-- host who is merely slow gets to close their own round first.
--
--   host present  -> host advances at timer + 0.5s, exactly as today
--   host absent   -> any phone can advance at timer + 8s
--
-- Eight seconds is nothing against a round that currently never ends.
-- ============================================


-- --------------------------------------------
-- 1. How long past the clock before anybody may force the issue
--
-- A function rather than a literal so the rule is stated once. It must stay
-- STRICTLY GREATER than op_submit_answer's 3-second allowance: the moment these
-- two meet, closing a round can destroy an answer the same database would have
-- accepted a millisecond earlier.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_advance_deadline(r rooms)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT r.question_started_at
       + make_interval(secs => coalesce(r.question_timer, 30))
       + interval '8 seconds';
$$;


-- --------------------------------------------
-- 2. Move the room on, if and only if the clock says so
--
-- Returns what it DID, as text, rather than a boolean. A caller needs to tell
-- "I moved it", "somebody else already had", and "it is not due yet" apart —
-- and collapsing those into true/false is how a working backstop and a broken
-- one come to look identical (CLAUDE.md #6).
--
-- IDEMPOTENT BY CONSTRUCTION. Every phone in the room polls, so simultaneous
-- calls are the normal case, not the edge case. Each transition is a single
-- UPDATE whose WHERE clause re-tests the phase it is moving out of, so the
-- second caller matches no row and reports 'already moved'. Nothing is read and
-- then written on the strength of the read.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_advance_phase(
  p_room_id   uuid,
  p_caller_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r rooms;
  moved int;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF r.id IS NULL THEN
    RETURN 'no such room';
  END IF;

  -- THE ONLY GUARD ON WHO MAY ASK: you have to be sitting in the room.
  --
  -- It cannot be "you are the host" — the entire point is that the host is the
  -- one who has gone. And it cannot be an identity check, because a guest has
  -- no auth.uid() at all; that is what guest play means. What this stops is a
  -- stranger with a room code poking other people's games from outside, which
  -- is the realistic abuse. Somebody already in the room could call it early,
  -- and gains nothing: the clock still has to have run out.
  IF NOT EXISTS (
    SELECT 1 FROM players WHERE room_id = p_room_id AND id = p_caller_id
  ) THEN
    RETURN 'not in this room';
  END IF;

  -- ---- countdown -> question ----
  --
  -- The countdown is 4.1s of animation (COUNTDOWN_DELAY_MS + 4 x
  -- COUNTDOWN_STEP_MS in js/constants.js). Ten seconds is well past any phone
  -- still playing it, and the client's own 3-second self-heal gets there first
  -- whenever anybody's phone is awake — this is for when none is.
  IF r.game_phase = 'countdown' THEN
    IF r.countdown_started_at IS NULL
       OR now() < r.countdown_started_at + interval '10 seconds' THEN
      RETURN 'not due';
    END IF;

    UPDATE rooms
       SET game_phase = 'question',
           current_question = 0,
           question_started_at = now()
     WHERE id = p_room_id
       AND game_phase = 'countdown';
    GET DIAGNOSTICS moved = ROW_COUNT;
    RETURN CASE WHEN moved > 0 THEN 'countdown -> question' ELSE 'already moved' END;
  END IF;

  -- ---- question with no clock -> start the clock ----
  --
  -- FOUND BY THE SCENARIO WRITTEN FOR THE STALL ABOVE, and it is a worse hang
  -- than that one. Announcing the question and stamping its clock are two
  -- separate writes from the host's phone: `handlePhaseTransition` broadcasts
  -- `game_phase = 'question'`, and the stamp is written afterwards, from inside
  -- showQuestionScreen. Die in between — which is a window of a few hundred
  -- milliseconds, and exactly where scenario-nasty's kill landed — and the room
  -- sits on a question whose timer NEVER STARTS on any phone.
  -- `getServerTimeLeft` returns the full duration for a null stamp, so the bar
  -- stays completely still and nothing ever expires. Forever.
  --
  -- The repair is to START it, never to end it. A round with no stamp has not
  -- begun, so ending it would take a question away from people who never got
  -- to see the clock move; stamping gives everybody a full, fair round from
  -- now, which is precisely what the host would have done had it lived. It
  -- cannot shorten anyone's time, which is what makes it safe to let any phone
  -- ask for it.
  IF r.game_phase IN ('question', 'final_question')
     AND r.question_started_at IS NULL THEN
    UPDATE rooms
       SET question_started_at = now()
     WHERE id = p_room_id
       AND game_phase = r.game_phase
       AND question_started_at IS NULL;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RETURN CASE WHEN moved > 0 THEN 'clock started' ELSE 'already moved' END;
  END IF;

  -- ---- question -> reveal ----
  IF r.game_phase IN ('question', 'final_question') THEN
    IF now() < op_advance_deadline(r) THEN
      RETURN 'not due';
    END IF;

    -- Close the round out BEFORE moving the phase, in that order.
    --
    -- op_fill_blank_answers gives a zero to everyone who never answered and
    -- converts any __WAGER_LOCKED__ placeholder into a blank. Doing it after
    -- the phase moved would let a client reach the reveal and render "No
    -- answer" for people whose rows had not been written yet — and the reveal
    -- is where a blank stops meaning "still typing" and starts meaning "never
    -- answered". It is idempotent, so a host who already ran it loses nothing.
    PERFORM op_fill_blank_answers(p_room_id, r.current_question);

    UPDATE rooms
       SET game_phase = 'reveal'
     WHERE id = p_room_id
       AND game_phase = r.game_phase
       AND current_question = r.current_question;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RETURN CASE WHEN moved > 0 THEN 'question -> reveal' ELSE 'already moved' END;
  END IF;

  -- Every other phase is a person's decision, not a clock's.
  RETURN 'nothing to do';
END;
$$;

GRANT EXECUTE ON FUNCTION op_advance_phase(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_advance_deadline(rooms) TO anon, authenticated;


-- --------------------------------------------
-- 3. Verify — by looking, and printing what was seen
--
-- Prints on every run whether it passes or not. 051 established why: when a
-- check and a fix disagree, an ok/FAIL cell cannot tell you which of two
-- explanations you are looking at, and settling it cost a round trip to the
-- owner that looking would have saved.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'op_advance_phase installed' AS thing,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_advance_phase')
    THEN 'ok' ELSE 'MISSING' END AS verdict

  UNION ALL SELECT 2, 'any player may call it',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — the stall is not fixed' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_advance_phase'), 'MISSING')

  UNION ALL SELECT 3, 'it runs with the owner''s rights',
    COALESCE((SELECT CASE WHEN p.prosecdef THEN 'ok'
                          ELSE 'FAIL it will be refused once rooms is locked' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_advance_phase'), 'MISSING')

  UNION ALL SELECT 4, 'the blank fill it depends on is present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
    THEN 'ok' ELSE 'MISSING — a forced reveal would show empty answers' END
) report ORDER BY ord;
