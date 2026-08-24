-- ============================================
-- 049 — ONLY A HOST CHANGES A VERDICT
--
-- Needs 045–048.
--
-- THE HOLE THIS CLOSES. `answers` has `FOR UPDATE USING (true)` and
-- `FOR DELETE USING (true)`. Every browser carries the publishable key, because
-- guests play without signing in, so anyone who can reach the site can mark any
-- answer in any live game right or wrong, set any score, or delete the lot.
-- Scores are computed from `answers.score_earned`, so editing one row edits the
-- scoreboard on every phone in the room.
--
-- WHY IT CAN BE CLOSED NOW. Until 046 the browsers had to write these columns
-- themselves — judging ran on the phone, so the right to record a verdict was
-- the right to play. That is over: op_submit_answer writes the verdict now, and
-- the only writes left from a client are the host's two deliberate corrections.
-- Both are rules, and both move here.
--
-- WHAT IT STILL CANNOT DO. It checks that the caller names a host or co-host of
-- that room; it cannot check that the caller IS them, because a guest has no
-- identity to check. So this stops a stranger, not somebody already in your
-- game. Same limit as everywhere else, and it is not a reason to leave the door
-- open to everyone.
--
-- INSERT STAYS OPEN, deliberately. The client falls back to writing an answer
-- directly when op_submit_answer is unreachable, and an RLS refusal returns no
-- error — so revoking INSERT would turn a bad connection into a silently lost
-- answer. UPDATE and DELETE are the destructive pair; INSERT waits until the
-- fallback goes.
--
-- ORDER: deploy the JavaScript first, then run this.
-- ============================================


-- --------------------------------------------
-- op_is_room_host — is this player allowed to run this room
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_is_room_host(p_room_id uuid, p_player_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM players
     WHERE id = p_player_id AND room_id = p_room_id
       AND (coalesce(is_host, false) OR coalesce(is_cohost, false))
  );
$$;


-- --------------------------------------------
-- op_set_judgement — the host disagrees with the machine
--
-- Recomputes the points from the row's OWN wager rather than taking a number
-- from the caller. That is the point of moving it: the old call passed both the
-- verdict and the score, so anything could send any score for any answer.
--
-- The final round is the only one that subtracts, and it is identified the same
-- way everywhere else — question_number >= total, where total is
-- array_length(question_ids) - 1.
--
-- IT DOES NOT TRY TO DETECT A DISQUALIFIED ROUND, and the first version did.
--
-- The client spots one by asking whether every answer in the round scored
-- nothing and nobody was marked right — a heuristic CLAUDE.md already records
-- as imperfect, because a round everybody simply got WRONG looks identical.
-- Porting it here was the wrong instinct: in a two-player game where one person
-- answered wrong and nobody else got it either, the round reads as
-- disqualified, so the commonest override there is — the host saying "actually
-- that was right" — would have been refused. The rule check caught it.
--
-- The client keeps that guard, where it has the better evidence: the
-- disqualification arrives as a message every phone in the room has seen, not
-- as an inference from the scores. What lives here is permission and
-- arithmetic, which is what a client cannot be trusted with.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_set_judgement(
  p_answer_id uuid,
  p_is_correct boolean,
  p_caller_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a answers;
  r rooms;
  total int;
  is_final boolean;
  earned int;
BEGIN
  SELECT * INTO a FROM answers WHERE id = p_answer_id;
  IF NOT FOUND THEN RETURN 'no such answer'; END IF;

  IF NOT op_is_room_host(a.room_id, p_caller_id) THEN
    RETURN 'not the host';
  END IF;

  SELECT * INTO r FROM rooms WHERE id = a.room_id;
  IF NOT FOUND THEN RETURN 'no such room'; END IF;

  total := op_room_total_questions(r);
  is_final := a.question_number >= total;

  earned := CASE WHEN p_is_correct THEN coalesce(a.wager, 0)
                 WHEN is_final THEN -coalesce(a.wager, 0)
                 ELSE 0 END;

  UPDATE answers
     SET is_correct = p_is_correct,
         score_earned = earned
   WHERE id = p_answer_id;

  -- auto_correct is DELIBERATELY untouched. It holds the machine's original
  -- verdict, and comparing the two is how a bad answer key is found later —
  -- times_overridden is the most valuable column in question_stats. Moving it
  -- here would erase the evidence that a human disagreed.
  RETURN 'changed';
END;
$$;


-- --------------------------------------------
-- op_disqualify_round — that question did not happen
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_disqualify_round(
  p_room_id uuid,
  p_question_number int,
  p_caller_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  IF NOT op_is_room_host(p_room_id, p_caller_id) THEN RETURN -1; END IF;

  UPDATE answers
     SET is_correct = false, score_earned = 0
   WHERE room_id = p_room_id AND question_number = p_question_number;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;


GRANT EXECUTE ON FUNCTION op_is_room_host(uuid, uuid)              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_set_judgement(uuid, boolean, uuid)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_disqualify_round(uuid, int, uuid)     TO anon, authenticated;


-- --------------------------------------------
-- AND SHUT THE DOOR ON EDITING AND DELETING
-- --------------------------------------------
DROP POLICY IF EXISTS "Answers: anyone can update" ON answers;
DROP POLICY IF EXISTS "Answers: anyone can delete" ON answers;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT
  CASE WHEN to_regprocedure('op_set_judgement(uuid,boolean,uuid)') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_set_judgement missing' END AS judge_fn,
  CASE WHEN to_regprocedure('op_disqualify_round(uuid,int,uuid)') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_disqualify_round missing' END AS dq_fn,
  -- 'ALL' counts: a single FOR ALL policy grants update and delete just as
  -- surely as two named ones, and reading only the named ones would report a
  -- door shut that is standing open.
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                         WHERE tablename = 'answers' AND cmd IN ('UPDATE','DELETE','ALL'))
       THEN 'ok' ELSE 'FAIL a stranger can still edit a score' END AS door_shut,
  -- Asks whether a player can still ANSWER, not whether a particular policy
  -- exists. On a database with RLS switched off there are no policies at all
  -- and inserting is allowed — the first version read that as a catastrophe
  -- and printed FAIL on a database where nothing was wrong. A check that cries
  -- wolf is one people stop reading.
  CASE WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'answers'::regclass)
         OR EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'answers' AND cmd IN ('INSERT','ALL'))
       THEN 'ok' ELSE 'FAIL players can no longer submit an answer' END AS can_still_answer;
