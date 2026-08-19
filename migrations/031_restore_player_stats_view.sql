-- ============================================
-- Migration 031 — restore player_stats_computed
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY THIS EXISTS
--
-- Migration 017 created this view and was apparently never run. Measured on
-- 2026-08-19, the live database answers PGRST205 — "could not find the table
-- in the schema cache" — for player_stats_computed, using the same publishable
-- key every player's phone uses.
--
-- That is not a permissions problem. A view that exists but is not granted
-- answers 42501 (permission denied); PGRST205 means PostgREST cannot see the
-- relation at all. So it is missing, not locked.
--
-- WHAT IS BROKEN WITHOUT IT
--
-- Four reads in js/db/social.js go to this view, and every one of them logs a
-- failure and returns an empty list — CLAUDE.md #4 exactly, a whole feature
-- dying quietly:
--
--   fetchAllPlayerStatsForLeaderboard  → the global leaderboard is empty
--   fetchCategoryLeaderboard           → every category leaderboard is empty
--   fetchPlayerStats                   → the profile page shows no stats,
--                                        AND evaluateUnlocks() is handed
--                                        nothing, so NO TITLE EVER UNLOCKS
--   fetchPlayerStatsBatch              → no tier badge ever appears in a lobby
--
-- The title system is the worst of these. It is not that titles unlock and
-- display wrongly — the unlock check runs against an empty array after every
-- game, finds nothing, and reports success.
--
-- WHY IT WENT UNNOTICED
--
-- The db probe was reporting this table as "all present" while its own
-- row-count section could not read it. The column check only counted a column
-- as missing on HTTP 400; a relation that does not exist answers 404 to every
-- request, so no column was ever recorded missing and the table came out
-- clean. Fixed in the same commit as this file — see CLAUDE.md #6.
--
-- WHAT IT DOES
--
-- Builds per-user, per-category (and per-subcategory) totals out of
-- question_history and game_history, which are the real records. The old
-- player_stats TABLE is left alone; nothing writes to it any more.
--
-- Identical to migration 017 apart from one rename: 017's first CTE was called
-- `question_stats`, which is now also the name of a real table (migration
-- 025). Inside the view the CTE wins, so 017 was never wrong — but a name that
-- shadows a real table is a trap for the next person reading it.
-- ============================================

CREATE OR REPLACE VIEW player_stats_computed AS
WITH qh_per_question AS (
  -- Join question_history with questions to get category + subcategory per
  -- answered question. Unnest the categories array so one question can count
  -- toward multiple categories.
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
  FROM qh_per_question
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
  FROM qh_per_question
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
    COUNT(*)::integer                              AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer AS wins
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
  COALESCE(g.wins, 0)                     AS wins
FROM q_combined q
FULL OUTER JOIN g_combined g
  ON  q.user_id    = g.user_id
  AND q.category   = g.category
  AND q.subcategory IS NOT DISTINCT FROM g.subcategory;

-- PostgREST reads as `anon` for a guest and `authenticated` for a signed-in
-- player. Both need it: the leaderboard is a public page.
GRANT SELECT ON player_stats_computed TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — the first number must be 1. The second is how many stat rows the
-- view produces from the history already recorded; 0 is fine and just means
-- no signed-in player has finished a game yet.
-- --------------------------------------------

SELECT
  (SELECT count(*) FROM information_schema.views
    WHERE table_name = 'player_stats_computed')  AS view_exists,
  (SELECT count(*) FROM player_stats_computed)   AS rows_produced;
