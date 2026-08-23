-- ============================================
-- 046 — THE SERVER RECORDS THE ANSWER
--
-- Needs 045 (op_answer_matches) applied first.
--
-- Second slice of moving the game off the host's phone (CLAUDE.md #1). 045 gave
-- the database the ability to judge; this is what makes it the thing that
-- actually does.
--
-- WHAT CHANGES FOR A PLAYER
--
-- Today each browser judges its own answer and writes its own is_correct and
-- score_earned. Two phones can therefore disagree about the same round, and a
-- tampered client can write any score it likes. After this the row is written
-- by the database: one verdict, computed once, identical on every screen.
--
-- Three things become impossible that were not:
--   * answering a question that is not the one on screen
--   * answering after the timer has run out
--   * spending a wager that has already been spent
-- Each was reachable today by anybody willing to edit a request.
--
-- WHAT DOES NOT CHANGE, AND MUST NOT BE CLAIMED TO
--
-- These functions do not know WHO is calling. A guest has no auth.uid() — that
-- is what guest play means — so a person with the room code can still act as
-- another player in that room. This stops a score being conjured out of
-- nothing. It does not stop somebody already in your game meddling, and it is
-- not the lockdown in #2; that comes when the RLS policies narrow, which is a
-- later slice and would break the app if it landed before the app stopped
-- writing these columns itself.
--
-- THE FINAL ROUND IS question_number = total, where total is
-- array_length(question_ids) - 1. The room holds N+1 questions: N regular
-- rounds numbered 0..N-1, then the final wager round at N. Getting this off by
-- one silently turns the round that SUBTRACTS points into one that does not.
-- ============================================


-- --------------------------------------------
-- op_room_total_questions — how many REGULAR rounds this room has
--
-- Reads the array rather than questions_per_game, because the array is what
-- the game actually plays and the setting is only what was asked for. Falls
-- back to the setting when the array has not been filled in yet.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_room_total_questions(p_room rooms)
RETURNS int
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT GREATEST(1, COALESCE(
    NULLIF(array_length(p_room.question_ids, 1), 0) - 1,
    p_room.questions_per_game,
    10
  ));
$$;


-- --------------------------------------------
-- op_next_wager — the lowest wager this player has not spent
--
-- A PORT OF findNextAvailableWager + buildUsedWagersMap, and it has to stay a
-- port: if the server hands somebody a wager their own screen thinks is still
-- available, they will be shown a number they cannot spend.
--
-- Skips, exactly as the client does:
--   * the final round, which has its own wager space (0/10/20)
--   * __WAGER_LOCKED__, a placeholder written when a final wager is chosen and
--     not an answer to anything
--   * disqualified rounds, where the wager really is refunded
--
-- THE DISQUALIFICATION TEST IS A HEURISTIC AND IS KNOWN TO BE IMPERFECT: a
-- round where everybody simply got it wrong looks identical to one that was
-- thrown out. It is ported faithfully anyway, flaw included, because the
-- client uses it and a server that disagreed would hand back a wager the
-- player's own screen had already spent. Fix it in both or in neither.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_next_wager(p_room_id uuid, p_player_id uuid, p_total int)
RETURNS int
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  used int[];
  i int;
BEGIN
  SELECT coalesce(array_agg(a.wager), ARRAY[]::int[]) INTO used
  FROM answers a
  WHERE a.room_id = p_room_id
    AND a.player_id = p_player_id
    AND a.question_number < p_total
    AND a.wager IS NOT NULL
    AND btrim(coalesce(a.submitted_answer, '')) <> '__WAGER_LOCKED__'
    AND NOT EXISTS (
      -- the round was disqualified: every answer in it scored nothing and
      -- nobody was marked right
      SELECT 1 FROM answers d
      WHERE d.room_id = p_room_id AND d.question_number = a.question_number
      HAVING bool_and(NOT d.is_correct AND coalesce(d.score_earned, 0) = 0)
    );

  FOR i IN 1..p_total LOOP
    IF NOT (i = ANY (used)) THEN RETURN i; END IF;
  END LOOP;
  RETURN 1;   -- everything spent; the client's fallback is the same
END;
$$;


-- --------------------------------------------
-- op_submit_answer — the one that matters
--
-- Returns one row. `rejected` is NULL when the answer was taken; otherwise it
-- names the reason and nothing was written. A rejection is not an error: the
-- app has to be able to tell "the timer beat you" from "the network died", and
-- RAISE would make both look the same to the client.
-- --------------------------------------------
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
      + make_interval(secs => coalesce(r.question_timer, 30))
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


-- --------------------------------------------
-- op_fill_blank_answers — everybody who never answered gets a zero
--
-- The host does this today when the timer expires, and it caused one of the
-- worst bugs in the project's history: the host's blank raced a player's real
-- answer and destroyed it. That was fixed with ON CONFLICT DO NOTHING, which
-- is kept here — but the deeper problem was that it took the HOST to do it at
-- all, so a host whose phone was asleep left the round hanging.
--
-- ANY client may call this, and it is idempotent, so the round closes as soon
-- as any phone in the room notices the clock has run out.
--
-- Returns how many rows it actually wrote, which is what makes it testable:
-- the second call must return 0.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_fill_blank_answers(
  p_room_id uuid,
  p_question_number int
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
  qid uuid;
  p record;
  written int := 0;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  total := op_room_total_questions(r);
  is_final := p_question_number >= total;
  qid := r.question_ids[p_question_number + 1];

  -- EVERY player, with the protection expressed ONCE, in the ON CONFLICT below.
  --
  -- This loop used to pre-filter to players who had not answered, so the
  -- ON CONFLICT guard sat behind a condition that already excluded the only
  -- case it defends against. Deleting that guard changed nothing any test could
  -- see: the same rule stated twice, and the test only ever reached the first
  -- statement of it. Now every player takes the same path and the guard is the
  -- only thing standing between a blank and somebody's real answer — which is
  -- both simpler and the reason removing it now fails loudly.
  FOR p IN
    SELECT pl.id FROM players pl
    WHERE pl.room_id = p_room_id
    ORDER BY pl.joined_at
  LOOP
    -- Each player burns THEIR OWN lowest unused wager, not a hardcoded 1.
    -- A shared 1 let one player spend the same value twice, and it is also the
    -- rule that makes vanishing cost exactly what being present and wrong
    -- costs — no more and no less.
    --
    -- A blank final wager is 0. Somebody who never touched the screen must not
    -- lose 20 points: the default of 20 exists to punish indecision, and
    -- committing it on a timeout would punish absence instead, which no other
    -- round does.
    INSERT INTO answers (room_id, player_id, question_number, question_id,
                         wager, submitted_answer, is_correct, auto_correct, score_earned)
    VALUES (p_room_id, p.id, p_question_number, qid,
            CASE WHEN is_final THEN 0 ELSE op_next_wager(p_room_id, p.id, total) END,
            '', false, false, 0)
    -- DO NOTHING would be wrong, and the SQL rule check caught it: somebody who
    -- LOCKED a final wager and then never typed anything already holds a row on
    -- this key, so the insert bounced and they were never given their zero. The
    -- client hit exactly this and needed a second pass for it.
    --
    -- THE `WHERE` IS THE WHOLE SAFETY PROPERTY. It converts a placeholder and
    -- only a placeholder, so a blank can never land on an answer somebody
    -- actually typed — the race that once destroyed real answers, where the
    -- fill reads the room a moment before a player's submission arrives and
    -- then writes over it.
    ON CONFLICT (room_id, player_id, question_number) DO UPDATE
      SET submitted_answer = '',
          wager            = EXCLUDED.wager,
          is_correct       = false,
          auto_correct     = false,
          score_earned     = 0
      WHERE btrim(coalesce(answers.submitted_answer, '')) = '__WAGER_LOCKED__';
    IF FOUND THEN written := written + 1; END IF;
  END LOOP;

  RETURN written;
END;
$$;


GRANT EXECUTE ON FUNCTION op_room_total_questions(rooms)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_next_wager(uuid, uuid, int)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_submit_answer(uuid, uuid, int, text, int)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_fill_blank_answers(uuid, int)               TO anon, authenticated;
