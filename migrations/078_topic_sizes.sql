-- ============================================
-- 078 — HOW BIG IS EACH TOPIC, IN ONE REQUEST
--
-- The owner's rule (2026-10-30): a title word's goal follows the topic's REAL
-- size. "A quarter of Body" means a quarter of however many Body questions
-- there are today, capped at 25 / 100 / 250 for Uncommon / Rare / Epic so the
-- easier words stay reachable however big the bank grows.
--
-- That needs every topic's size on a player's phone. Counting each topic with
-- its own request is ~64 requests (the admin page does exactly that, batched);
-- this answers all of them at once. It counts what the game can ASK, exactly
-- as fetchQuestionCount does: the question carries the category, and its
-- format is 'open'.
--
-- Rows are (category, subcategory, n) per stored subcategory; the client adds
-- them up by prefix, because a topic like `human` includes `human-countries`.
--
-- Read-only and harmless, so anyone may call it. SECURITY DEFINER only so it
-- does not depend on what a visitor may read of `questions`.
--
-- Until this is run the app keeps using the target saved with each word, which
-- is what it did before — nothing breaks.
-- ============================================

CREATE OR REPLACE FUNCTION get_topic_sizes()
RETURNS TABLE (category text, subcategory text, n bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.cat, q.subcategory, count(*)::bigint
    FROM questions q
    CROSS JOIN LATERAL unnest(q.categories) AS c(cat)
   WHERE q.format = 'open'
   GROUP BY c.cat, q.subcategory;
$$;

REVOKE ALL ON FUNCTION get_topic_sizes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_topic_sizes() TO anon, authenticated;

-- ============================================
-- VERIFICATION — run this SELECT on its own. Both rows should read ok.
-- ============================================
SELECT 'get_topic_sizes installed' AS rule,
       CASE WHEN to_regprocedure('public.get_topic_sizes()') IS NOT NULL THEN 'ok' ELSE 'FAIL' END AS verdict
UNION ALL
SELECT 'it counts the whole open bank',
       CASE WHEN (SELECT sum(n) FROM get_topic_sizes())
              >= (SELECT count(*) FROM questions WHERE format = 'open') THEN 'ok' ELSE 'FAIL' END;
