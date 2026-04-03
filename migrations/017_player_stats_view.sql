-- Migration: Replace player_stats table with a computed view
--
-- player_stats was a manually-maintained aggregate table that could drift
-- out of sync with the source-of-truth tables (question_history, game_history).
-- This view computes the same columns on the fly from real data.
--
-- The original player_stats table is kept (not dropped) but no longer written to.

CREATE OR REPLACE VIEW player_stats_computed AS
WITH question_stats AS (
  -- Join question_history with questions to get category + subcategory per answered question.
  -- Unnest the categories array so one question can count toward multiple categories.
  SELECT
    qh.user_id,
    unnest(q.categories) AS category,
    q.subcategory,
    qh.times_seen    AS questions_answered,
    qh.times_correct AS correct_answers
  FROM question_history qh
  JOIN questions q ON q.id = qh.question_id
),

-- Subcategory-level question stats
q_by_subcat AS (
  SELECT
    user_id,
    category,
    subcategory,
    SUM(questions_answered)::integer AS questions_answered,
    SUM(correct_answers)::integer    AS correct_answers
  FROM question_stats
  WHERE subcategory IS NOT NULL
  GROUP BY user_id, category, subcategory
),

-- Category-level question stats (all subcategories rolled up, subcategory = NULL)
q_by_cat AS (
  SELECT
    user_id,
    category,
    NULL::text AS subcategory,
    SUM(questions_answered)::integer AS questions_answered,
    SUM(correct_answers)::integer    AS correct_answers
  FROM question_stats
  GROUP BY user_id, category
),

q_combined AS (
  SELECT * FROM q_by_subcat
  UNION ALL
  SELECT * FROM q_by_cat
),

-- Subcategory-level game stats
g_by_subcat AS (
  SELECT
    user_id,
    category,
    subcategory,
    COUNT(*)::integer                                    AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer       AS wins
  FROM game_history
  WHERE subcategory IS NOT NULL
  GROUP BY user_id, category, subcategory
),

-- Category-level game stats (all games in this category regardless of subcategory)
g_by_cat AS (
  SELECT
    user_id,
    category,
    NULL::text AS subcategory,
    COUNT(*)::integer                                    AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer       AS wins
  FROM game_history
  GROUP BY user_id, category
),

g_combined AS (
  SELECT * FROM g_by_subcat
  UNION ALL
  SELECT * FROM g_by_cat
)

SELECT
  COALESCE(q.user_id, g.user_id)         AS user_id,
  COALESCE(q.category, g.category)        AS category,
  q.subcategory                           AS subcategory,
  COALESCE(q.questions_answered, 0)       AS questions_answered,
  COALESCE(q.correct_answers, 0)          AS correct_answers,
  COALESCE(g.games_played, 0)             AS games_played,
  COALESCE(g.wins, 0)                     AS wins
FROM q_combined q
FULL OUTER JOIN g_combined g
  ON  q.user_id    = g.user_id
  AND q.category   = g.category
  AND q.subcategory IS NOT DISTINCT FROM g.subcategory;

-- Grant read access so PostgREST (anon + authenticated) can query the view
GRANT SELECT ON player_stats_computed TO anon, authenticated;
