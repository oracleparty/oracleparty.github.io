-- ============================================
-- Migration 040 — proficiency counts QUESTIONS, not attempts
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHAT CHANGES
--
-- Accuracy has always been SUM(times_correct) / SUM(times_seen): a lifetime hit
-- rate over ATTEMPTS. Every miss is permanent dead weight — you can dilute it
-- by playing more, but you can never undo it, not even by learning the answer.
--
-- The owner's proposal, and it is a better fit for a game that calls the number
-- "Proficiency": count QUESTIONS, and let the most recent result win. Answering
-- the same question wrong then right leaves you knowing it, so it should count
-- as known. Answering it right then wrong leaves you not knowing it, so it
-- should count as not known. Repeats do not stack in either direction.
--
--   proficiency = questions you now get right / questions you have met
--
-- This shares its numerator with Mastery, which is the same count over the
-- whole bank rather than over what you have seen. Two numbers, one meaning
-- each: how much of the bank you have, and how much of what you have seen.
--
-- WHY IT MATTERS BEYOND TIDINESS
--
-- It makes a bad round RECOVERABLE. Someone distracted, disconnected, or having
-- an off night takes a dip that the next sighting of that question repairs
-- completely. Under the old rate that dip was permanent, which meant the number
-- was partly a record of how often somebody's phone had been awake. It is only
-- as good as the resurfacing rule, though: a question never asked again keeps
-- its old verdict forever. fetchQuestionsByCategory already re-serves missed
-- questions, and question_history.next_eligible_at exists and is unused — that
-- column is where a real spacing rule would go.
--
-- ADDITIVE ON PURPOSE
--
-- questions_answered and correct_answers are UNCHANGED and still count
-- attempts. They are the volume measure — how much you have played — and the
-- leaderboard's points are built on them deliberately. Only the columns used
-- for a PERCENTAGE move. CREATE OR REPLACE VIEW cannot reorder or retype
-- existing columns, so the two new ones are appended, which is also the safest
-- shape: nothing that reads the old columns can break.
-- ============================================

CREATE OR REPLACE VIEW player_stats_computed AS
WITH qh_per_question AS (
  SELECT
    qh.user_id,
    unnest(q.categories) AS category,
    q.subcategory,
    qh.question_id,
    qh.times_seen    AS questions_answered,
    qh.times_correct AS correct_answers,
    -- The verdict of the MOST RECENT sighting. Maintained by
    -- upsertQuestionHistory on a new attempt and by amendQuestionHistory when a
    -- host changes their mind; revokeQuestionHistory steps it back out.
    COALESCE(qh.last_correct, false) AS last_correct
  FROM question_history qh
  JOIN questions q ON q.id = qh.question_id
),

q_by_subcat AS (
  SELECT
    user_id, category, subcategory,
    SUM(questions_answered)::integer AS questions_answered,
    SUM(correct_answers)::integer    AS correct_answers,
    COUNT(DISTINCT question_id)::integer AS questions_met,
    COUNT(DISTINCT question_id) FILTER (WHERE last_correct)::integer AS questions_mastered
  FROM qh_per_question
  WHERE subcategory IS NOT NULL
  GROUP BY user_id, category, subcategory
),

q_by_cat AS (
  SELECT
    user_id, category,
    NULL::text AS subcategory,
    SUM(questions_answered)::integer AS questions_answered,
    SUM(correct_answers)::integer    AS correct_answers,
    COUNT(DISTINCT question_id)::integer AS questions_met,
    COUNT(DISTINCT question_id) FILTER (WHERE last_correct)::integer AS questions_mastered
  FROM qh_per_question
  GROUP BY user_id, category
),

q_combined AS (
  SELECT * FROM q_by_subcat
  UNION ALL
  SELECT * FROM q_by_cat
),

g_by_subcat AS (
  SELECT
    user_id, category, subcategory,
    COUNT(*)::integer                              AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer AS wins
  FROM game_history
  WHERE subcategory IS NOT NULL
  GROUP BY user_id, category, subcategory
),

g_by_cat AS (
  SELECT
    user_id, category,
    NULL::text AS subcategory,
    COUNT(*)::integer                              AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer AS wins
  FROM game_history
  GROUP BY user_id, category
),

g_combined AS (
  SELECT * FROM g_by_subcat
  UNION ALL
  SELECT * FROM g_by_cat
)

SELECT
  COALESCE(q.user_id, g.user_id)          AS user_id,
  COALESCE(q.category, g.category)        AS category,
  q.subcategory                           AS subcategory,
  COALESCE(q.questions_answered, 0)       AS questions_answered,
  COALESCE(q.correct_answers, 0)          AS correct_answers,
  COALESCE(g.games_played, 0)             AS games_played,
  COALESCE(g.wins, 0)                     AS wins,
  -- Appended, not inserted: CREATE OR REPLACE VIEW can only add columns at the
  -- end. Anything still reading the four above is unaffected.
  COALESCE(q.questions_met, 0)            AS questions_met,
  COALESCE(q.questions_mastered, 0)       AS questions_mastered
FROM q_combined q
FULL OUTER JOIN g_combined g
  ON  q.user_id    = g.user_id
  AND q.category   = g.category
  AND q.subcategory IS NOT DISTINCT FROM g.subcategory;

GRANT SELECT ON player_stats_computed TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — both new columns should be listed, and mastered must never exceed
-- met (a question you know is a question you have seen).
-- --------------------------------------------

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'player_stats_computed'
      AND column_name IN ('questions_met', 'questions_mastered'))  AS new_columns,
  (SELECT count(*) FROM player_stats_computed
    WHERE questions_mastered > questions_met)                      AS impossible_rows;
