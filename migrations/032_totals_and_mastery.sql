-- ============================================
-- Migration 032 — honest global totals, and a faster mastery tree
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- Two independent pieces. Neither changes any data.
--
-- ============================================
-- PIECE 1 — player_totals_computed
--
-- A question may be filed under several topics, and it SHOULD count toward
-- each of those proficiencies: getting a question right that is both History
-- and Culture really is evidence about both. player_stats_computed does that
-- correctly and is not changing.
--
-- The problem is only the single combined number on the global leaderboard.
-- That is built by adding the per-topic rows together, so one answer filed
-- under two topics lands in the total twice. Measured 2026-08-19: 105 of 1000
-- questions carry more than one topic (11%), 1.11 topics each on average. Not
-- catastrophic — but it varies by which questions a player happened to get, so
-- it can reorder players who are close rather than simply inflating everyone.
--
-- The fix is to count each answered question ONCE for the combined total, by
-- reading question_history directly instead of the per-topic rollups. Same
-- metric as before — correct answers, not game scores, which depend on wagers
-- and on which host was judging — just counted once each.
--
-- Games and wins come from game_history, where a game already belongs to
-- exactly one category, so those were never double counted.
-- ============================================

CREATE OR REPLACE VIEW player_totals_computed AS
WITH q AS (
  SELECT
    user_id,
    SUM(times_seen)::integer    AS questions_answered,
    SUM(times_correct)::integer AS correct_answers
  FROM question_history
  GROUP BY user_id
),
g AS (
  SELECT
    user_id,
    COUNT(*)::integer                              AS games_played,
    COUNT(*) FILTER (WHERE placement = 1)::integer AS wins
  FROM game_history
  GROUP BY user_id
)
SELECT
  COALESCE(q.user_id, g.user_id)     AS user_id,
  COALESCE(q.questions_answered, 0)  AS questions_answered,
  COALESCE(q.correct_answers, 0)     AS correct_answers,
  COALESCE(g.games_played, 0)        AS games_played,
  COALESCE(g.wins, 0)                AS wins
FROM q
FULL OUTER JOIN g ON q.user_id = g.user_id;

-- The leaderboard is a public page, so a guest needs to read it too.
GRANT SELECT ON player_totals_computed TO anon, authenticated;


-- ============================================
-- PIECE 2 — get_mastery_counts
--
-- The mastery tree asks "how many questions in each topic have I got right at
-- least once". js/ has always called this function, it has never existed, and
-- fetchMasteryCounts quietly falls back to doing the work on the phone: pull
-- every mastered question id, then fetch those questions in batches of 100
-- just to read their category. It works — it is just many round trips where
-- one would do.
--
-- DELIBERATELY NOT SECURITY DEFINER. Both callers pass the signed-in player's
-- own id, and running as the caller means the existing row-level policy on
-- question_history still applies — so this function can only ever return your
-- own mastery, exactly like the fallback it replaces. Marking it DEFINER would
-- have quietly made everyone's mastery readable by anyone who guessed a user
-- id, which is a bigger change than a speed-up should ever make.
--
-- Returns the same shape the fallback builds: one row per (category,
-- subcategory) with a count.
-- ============================================

CREATE OR REPLACE FUNCTION get_mastery_counts(p_user_id uuid)
RETURNS TABLE (category text, subcategory text, mastered integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    c.category,
    q.subcategory,
    COUNT(*)::integer AS mastered
  FROM question_history qh
  JOIN questions q ON q.id = qh.question_id
  CROSS JOIN LATERAL unnest(q.categories) AS c(category)
  WHERE qh.user_id = p_user_id
    AND qh.last_correct = true
  GROUP BY c.category, q.subcategory;
$$;

GRANT EXECUTE ON FUNCTION get_mastery_counts(uuid) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — both numbers must be 1.
-- --------------------------------------------

SELECT
  (SELECT count(*) FROM information_schema.views
    WHERE table_name = 'player_totals_computed')  AS totals_view,
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'get_mastery_counts')         AS mastery_function;
