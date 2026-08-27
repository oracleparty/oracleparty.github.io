-- ============================================
-- Migration 053: the leaderboard ranks what you KNOW, among people you know
--
-- WHY
--
-- The global board ranked on "points", which is correct_answers — a count of
-- ATTEMPTS. Answer the same question ten times and it counts ten times, so the
-- measure rewarded re-grinding a handful of questions over learning new ones,
-- and it disagreed with every other number in the app: the profile, the Map,
-- the tiers and the category boards all count QUESTIONS.
--
-- It was also unbounded, which is what makes a top score look unreachable to a
-- new player, and what makes a faked one impossible to spot. Mastery is capped
-- at the size of the question bank, so a leader at 6% reads as an invitation
-- and a leader at 100% reads as a liar.
--
-- The owner's decision, after weighing it: the board is FRIENDS ONLY. With no
-- global prize there is little left to fake for, and a friend whose numbers look
-- wrong can simply be unfriended — which is a remedy a global board has no
-- equivalent of. This function is therefore always called with an explicit list
-- of user ids; it has no "everybody" mode by design.
--
-- WHAT IT RETURNS
--
--   questions_met       distinct questions this player has met
--   questions_mastered  distinct questions they CURRENTLY get right
--
-- Proficiency is mastered/met and mastery is the count itself, so one call
-- answers both measures the owner asked for.
--
-- THREE THINGS THAT ARE LOAD-BEARING
--
-- 1. COUNT(DISTINCT question_id), not SUM(times_seen). That is the whole point
--    — see above — and it also fixes a bug for free. player_totals_computed
--    exists (migration 032) only because summing the per-category rollups counts
--    a question filed under two categories twice, and 11% of the bank carries
--    more than one. Counting distinct question ids cannot double count, so the
--    "All categories" case here is correct without a second view.
--
-- 2. COALESCE(last_correct, times_correct > 0). `last_correct` is the verdict
--    of the most recent sighting (migration 040) and is what "mastered" means
--    everywhere in this app. Rows written before 016 have it null; without the
--    fallback those players read as having mastered nothing. `rowProficiency`
--    in js/titles.js carries the identical fallback for the identical reason.
--
-- 3. p_since filters on last_seen_at, and that is the OWNER'S definition of a
--    time window, which is better than the one I proposed. "Questions you
--    currently get right, last seen inside the window." Drop the window and it
--    collapses to plain mastery with no special case and no new column — an
--    earlier draft of this wanted a first_correct_at column to express the same
--    idea and did not need to.
--
--    Honest limitation, stated because it will look like a bug otherwise: a
--    question learned a year ago and not seen since does NOT appear in a 30-day
--    window. So a window measures recent ACTIVITY that stuck, not new learning.
--
-- SUBCATEGORY MATCHING is LIKE 'key%', the same rule question selection uses,
-- because subcategories nest (human -> human-countries). tests/categories.test.js
-- pins that no key prefixes an unrelated one, which is what makes this safe.
--
-- NOT security definer. question_history and questions are both readable by
-- anyone already (migration 011: "public read"), so this borrows no rights it
-- would not otherwise have. It exists to do the join and the DISTINCT in one
-- round trip instead of shipping thousands of rows to a phone.
-- ============================================

CREATE OR REPLACE FUNCTION get_leaderboard(
  p_user_ids     uuid[],
  p_category     text        DEFAULT NULL,
  p_subcategory  text        DEFAULT NULL,
  p_since        timestamptz DEFAULT NULL
)
RETURNS TABLE (
  user_id            uuid,
  questions_met      integer,
  questions_mastered integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    qh.user_id,
    COUNT(DISTINCT qh.question_id)::integer AS questions_met,
    COUNT(DISTINCT qh.question_id)
      FILTER (WHERE COALESCE(qh.last_correct, qh.times_correct > 0))::integer
      AS questions_mastered
  FROM question_history qh
  JOIN questions q ON q.id = qh.question_id
  WHERE qh.user_id = ANY(p_user_ids)
    AND (p_since IS NULL OR qh.last_seen_at >= p_since)
    AND (p_category IS NULL OR p_category = ANY(q.categories))
    AND (p_subcategory IS NULL OR q.subcategory LIKE p_subcategory || '%')
  GROUP BY qh.user_id;
$$;

GRANT EXECUTE ON FUNCTION get_leaderboard(uuid[], text, text, timestamptz)
  TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — run this whole file, then read the result.
--
-- It LOOKS rather than asserting a count, because a check that prints only
-- ok/FAIL cannot tell you why it failed, and this project has spent a round
-- trip to the owner on exactly that before.
-- --------------------------------------------
SELECT
  p.proname                                   AS function_name,
  pg_get_function_identity_arguments(p.oid)   AS arguments,
  CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
       THEN 'yes' ELSE 'NO — the app cannot call it' END AS anon_may_call
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_leaderboard';
