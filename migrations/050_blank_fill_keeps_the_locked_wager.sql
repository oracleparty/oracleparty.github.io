-- ============================================
-- 050 — A BLANK FINAL ANSWER KEEPS THE WAGER IT LOCKED
--       and the answers door actually shuts
--
-- Needs 045–049.
--
-- TWO THINGS, both found from a live game.
--
-- 1. "I bet 20 on the final question and it wagered 0."
--
-- op_fill_blank_answers converts a __WAGER_LOCKED__ placeholder into a blank
-- answer, and it was ALSO setting the wager to 0. That is right for the score
-- — going quiet on the final round must cost nothing — but it destroys the
-- number the player chose. And then, if their answer lands a moment later, the
-- rule that a locked final wager cannot be revised reads the 0 the fill just
-- wrote and commits it. Bet 20, scored as 0.
--
-- The fix separates the two: the wager the player locked STAYS on the row, and
-- what a blank costs is expressed where it belongs, in score_earned. A blank
-- final answer still costs nothing. A real answer that arrives is still judged
-- against the wager the player actually chose.
--
-- 2. The 049 door did not shut.
--
-- It dropped the two policies BY NAME, and the names on the live database are
-- not the ones migration 022 wrote — so the drops did nothing, silently, and
-- the verification correctly reported that a stranger could still edit a score.
-- This drops whatever is actually there, by looking, and recreates the SELECT
-- and INSERT policies first so it cannot lock players out on the way past.
-- ============================================


-- --------------------------------------------
-- 1. The blank fill stops eating the locked wager
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

  FOR p IN
    SELECT pl.id FROM players pl
    WHERE pl.room_id = p_room_id
    ORDER BY pl.joined_at
  LOOP
    INSERT INTO answers (room_id, player_id, question_number, question_id,
                         wager, submitted_answer, is_correct, auto_correct, score_earned)
    VALUES (p_room_id, p.id, p_question_number, qid,
            CASE WHEN is_final THEN 0 ELSE op_next_wager(p_room_id, p.id, total) END,
            '', false, false, 0)
    ON CONFLICT (room_id, player_id, question_number) DO UPDATE
      SET submitted_answer = '',
          -- KEEP WHAT THEY LOCKED. Overwriting it with 0 threw away the number
          -- the player chose, and a real answer arriving a moment later then
          -- inherited that 0 — "I bet 20 and it wagered 0". What a blank COSTS
          -- is score_earned, immediately below, and that is still nothing.
          wager            = COALESCE(answers.wager, EXCLUDED.wager),
          is_correct       = false,
          auto_correct     = false,
          score_earned     = 0
      WHERE btrim(coalesce(answers.submitted_answer, '')) = '__WAGER_LOCKED__';
    IF FOUND THEN written := written + 1; END IF;
  END LOOP;

  RETURN written;
END;
$$;

GRANT EXECUTE ON FUNCTION op_fill_blank_answers(uuid, int) TO anon, authenticated;


-- --------------------------------------------
-- 2. Shut the door by looking at what is there
--
-- Order matters: make sure reading and answering are explicitly allowed BEFORE
-- removing anything, because a policy written FOR ALL grants those too and
-- dropping it blind would stop players submitting answers at all.
-- --------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'answers' AND cmd = 'SELECT') THEN
    EXECUTE 'CREATE POLICY "Answers: anyone can read" ON answers FOR SELECT USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'answers' AND cmd = 'INSERT') THEN
    EXECUTE 'CREATE POLICY "Answers: anyone can insert" ON answers FOR INSERT WITH CHECK (true)';
  END IF;

  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'answers'
                AND cmd IN ('UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON answers', pol.policyname);
  END LOOP;
END $$;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                         WHERE tablename = 'answers' AND cmd IN ('UPDATE','DELETE','ALL'))
       THEN 'ok' ELSE 'FAIL a stranger can still edit a score' END AS door_shut,
  CASE WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'answers'::regclass)
         OR EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'answers' AND cmd IN ('INSERT','ALL'))
       THEN 'ok' ELSE 'FAIL players can no longer submit an answer' END AS can_still_answer,
  CASE WHEN NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'answers'::regclass)
         OR EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'answers' AND cmd IN ('SELECT','ALL'))
       THEN 'ok' ELSE 'FAIL nobody can read the answers' END AS can_still_read,
  CASE WHEN to_regprocedure('op_fill_blank_answers(uuid,int)') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_fill_blank_answers missing' END AS fill_fn;
