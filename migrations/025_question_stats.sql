-- ============================================
-- Migration 025 — durable per-question performance stats
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY THIS TABLE IS NEEDED
--
-- Neither existing source can answer "how does this question actually
-- perform?":
--   * answers      — deleted when a room is cleaned up, so it holds only
--                    in-flight games. Confirmed empty on the live project.
--   * question_history — keyed on user_id, so guests (most players) record
--                    nothing at all.
--
-- question_stats is keyed on the question and counts every player, guest or
-- not, and is never cleaned up with rooms.
--
-- OVERRIDES ARE THE IMPORTANT COLUMN
--
-- times_overridden counts how often a host flipped the automatic judgement.
-- A host manually marking an answer correct is a human stating that a valid
-- answer was rejected — the strongest available evidence that a question's
-- acceptable_answers list is incomplete. It needs no player effort and no
-- guessing.
-- ============================================

-- Preserve the machine's original verdict. is_correct is overwritten in place
-- when a host flips a judgement, so without this the fact that an override
-- happened is lost the instant it happens.
ALTER TABLE answers
  ADD COLUMN IF NOT EXISTS auto_correct boolean;

CREATE TABLE IF NOT EXISTS question_stats (
  question_id      uuid PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  times_asked      integer NOT NULL DEFAULT 0,
  times_correct    integer NOT NULL DEFAULT 0,
  times_overridden integer NOT NULL DEFAULT 0,   -- host disagreed with auto-judging
  last_asked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_qs_asked ON question_stats(times_asked DESC);

ALTER TABLE question_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Question stats: anyone can read" ON question_stats;
CREATE POLICY "Question stats: anyone can read"
  ON question_stats FOR SELECT USING (true);

-- No direct INSERT/UPDATE policy: all writes go through the function below,
-- so a client cannot forge or wipe a question's record.

-- --------------------------------------------
-- Atomic recorder. One call per player per question.
-- SECURITY DEFINER so it can write while the table stays closed to clients.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION record_question_outcome(
  p_question_id uuid,
  p_is_correct  boolean,
  p_overridden  boolean
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO question_stats AS qs
      (question_id, times_asked, times_correct, times_overridden, last_asked_at)
  VALUES
      (p_question_id, 1,
       CASE WHEN p_is_correct THEN 1 ELSE 0 END,
       CASE WHEN p_overridden THEN 1 ELSE 0 END,
       now())
  ON CONFLICT (question_id) DO UPDATE SET
      times_asked      = qs.times_asked + 1,
      times_correct    = qs.times_correct + CASE WHEN p_is_correct THEN 1 ELSE 0 END,
      times_overridden = qs.times_overridden + CASE WHEN p_overridden THEN 1 ELSE 0 END,
      last_asked_at    = now();
$$;

GRANT EXECUTE ON FUNCTION record_question_outcome(uuid, boolean, boolean) TO anon, authenticated;


-- --------------------------------------------
-- Convenience view for the admin Question Health page: every question with
-- its performance and feedback tallies, worst first.
-- --------------------------------------------
CREATE OR REPLACE VIEW question_health AS
SELECT
  q.id,
  q.question,
  q.correct_answer,
  q.acceptable_answers,
  q.categories,
  q.subcategory,
  q.difficulty,
  q.format,
  COALESCE(s.times_asked, 0)                      AS times_asked,
  COALESCE(s.times_correct, 0)                    AS times_correct,
  COALESCE(s.times_overridden, 0)                 AS times_overridden,
  CASE WHEN COALESCE(s.times_asked, 0) = 0 THEN NULL
       ELSE round(100.0 * s.times_correct / s.times_asked)
  END                                             AS pct_correct,
  COALESCE(f.thumbs_up, 0)                        AS thumbs_up,
  COALESCE(f.thumbs_down, 0)                      AS thumbs_down,
  COALESCE(f.thumbs_up, 0) + COALESCE(f.thumbs_down, 0) AS total_votes,
  -- A single percentage is easier to read than two counts, but it hides
  -- sample size: one thumbs-up is 100%. total_votes is exposed alongside so
  -- the figure can be judged, and ranking by it requires a minimum sample.
  CASE WHEN COALESCE(f.thumbs_up, 0) + COALESCE(f.thumbs_down, 0) = 0 THEN NULL
       ELSE round(100.0 * f.thumbs_up / (f.thumbs_up + f.thumbs_down))
  END                                             AS pct_liked,
  COALESCE(f.flags, 0)                            AS flags,
  s.last_asked_at
FROM questions q
LEFT JOIN question_stats s ON s.question_id = q.id
LEFT JOIN (
  SELECT question_id,
         count(*) FILTER (WHERE feedback_type = 'thumbs_up')   AS thumbs_up,
         count(*) FILTER (WHERE feedback_type = 'thumbs_down') AS thumbs_down,
         count(*) FILTER (WHERE feedback_type = 'flag')        AS flags
    FROM question_feedback
   GROUP BY question_id
) f ON f.question_id = q.id;

GRANT SELECT ON question_health TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — both should report 1.
-- --------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_name = 'question_stats') AS stats_table,
  (SELECT count(*) FROM pg_proc WHERE proname = 'record_question_outcome')             AS recorder_function;
