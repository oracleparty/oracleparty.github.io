-- ============================================
-- Migration 029 — what people actually typed
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY
--
-- Bad questions are currently found two ways: a player bothers to flag one, or
-- a host notices and overrides the judgement. Both need somebody to act.
--
-- A tally of the answers people actually give finds them with nobody doing
-- anything. Eleven people typing "JFK" and being marked wrong is not eleven
-- people being wrong — it is one missing acceptable answer, and it would sit at
-- the top of a list. The same list shows spelling variants fuzzy matching
-- misses, and questions where everyone types something different, which
-- usually means the question is unclear.
--
-- It also supplies real wrong answers for bots, so none ever has to be
-- invented.
--
-- WHAT IS DELIBERATELY NOT STORED
--
--   * WHO gave the answer. There is no player or user column and there will
--     not be one. This is about the question, not the person.
--   * WHETHER it was marked correct. That verdict depends on which host was
--     judging and whether they overrode it, so it is noise. question_stats
--     already tracks correctness separately.
--   * Anything a BOT typed. A bot's answers come from a percentage somebody
--     chose, so counting them would mean this table is partly made of that
--     invented number.
--
-- NORMALISATION
--
-- Counting is on lowercase, whitespace-trimmed text, so "JFK" and "  jfk "
-- are one row. Punctuation and spelling are left alone: "J.F.K." stays
-- separate, and a near-miss spelling is exactly the thing worth seeing.
-- One example of the original capitalisation is kept for display.
-- ============================================

CREATE TABLE IF NOT EXISTS answer_tally (
  question_id  uuid    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_key   text    NOT NULL,          -- lowercased, trimmed; the counting key
  answer_shown text    NOT NULL,          -- one example, as somebody typed it
  times_given  integer NOT NULL DEFAULT 0,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, answer_key)
);

-- Reading a question's answers, most common first.
CREATE INDEX IF NOT EXISTS idx_answer_tally_question
  ON answer_tally (question_id, times_given DESC);

ALTER TABLE answer_tally ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Answer tally: anyone can read" ON answer_tally;
CREATE POLICY "Answer tally: anyone can read"
  ON answer_tally FOR SELECT USING (true);

-- No INSERT/UPDATE/DELETE policy at all. Every write goes through the function
-- below, which is SECURITY DEFINER, so no client can forge or wipe a count.
-- This is the same shape as question_stats in migration 025.

-- --------------------------------------------
-- Record one answer. Called once per player per question, by the host.
--
-- Blank answers are ignored: a player who ran out of time has not told us
-- anything about the question.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION record_answer_text(
  p_question_id uuid,
  p_answer      text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_shown text;
BEGIN
  IF p_question_id IS NULL OR p_answer IS NULL THEN
    RETURN;
  END IF;

  v_shown := btrim(p_answer);
  IF v_shown = '' THEN
    RETURN;
  END IF;

  -- Guard against a pasted essay becoming a row of its own.
  v_shown := left(v_shown, 120);
  v_key   := lower(v_shown);

  INSERT INTO answer_tally AS t (question_id, answer_key, answer_shown, times_given)
  VALUES (p_question_id, v_key, v_shown, 1)
  ON CONFLICT (question_id, answer_key) DO UPDATE
     SET times_given = t.times_given + 1,
         last_seen   = now();
END;
$$;

GRANT EXECUTE ON FUNCTION record_answer_text(uuid, text) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — should report the table and the function as present.
-- --------------------------------------------

SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'answer_tally')                                AS tally_table,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'record_answer_text')                             AS recorder_function,
  (SELECT count(*) FROM pg_policies
    WHERE tablename = 'answer_tally')                                 AS policies;
