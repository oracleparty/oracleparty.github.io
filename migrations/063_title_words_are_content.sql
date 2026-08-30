-- ============================================
-- 063 — TITLE WORDS ARE CONTENT, NOT CODE
--
-- The owner has roughly 86 title words still to write, and until now each one
-- meant asking me to edit js/titles.js. That is the wrong shape: in this project
-- words are CONTENT, and content lives in the database and is edited from the
-- admin page — exactly as the question bank's answers and alternates already
-- are. A trickle of two words a week should not need a deploy.
--
-- THE STRUCTURE IS NOT STORED. Which slots exist, and what each one requires, is
-- computed from CATEGORY_META and js/title-tiers.js — a subject's word at 10
-- right, and a topic's at a quarter, three quarters or all of it, for topics big
-- enough to offer that tier. This table holds only the TEXT the owner types.
-- Storing the rules here as well would give two sources for one truth, which is
-- the shape this codebase has been bitten by repeatedly.
--
-- A SLOT WITH NO ROW IS INVISIBLE TO PLAYERS. That is the rule the owner set and
-- it is the reason this table can be empty and nothing breaks: hitting a
-- requirement and receiving nothing is a promise broken, so a slot only exists
-- once somebody has written a word for it. Deleting the row takes it away again.
-- ============================================

CREATE TABLE IF NOT EXISTS title_words (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slot         smallint NOT NULL DEFAULT 2,
  category     text NOT NULL,
  -- NULL means the subject's own word rather than one of its topics. A partial
  -- unique index is needed for that, because NULL is not equal to NULL in a
  -- plain UNIQUE and the same subject word could be written twice.
  subcategory  text,
  tier         text NOT NULL,
  word         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT title_words_tier_check CHECK (
    tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic')
  ),
  CONSTRAINT title_words_word_check CHECK (length(btrim(word)) BETWEEN 1 AND 24)
);

-- One word per slot, counting a NULL subcategory as its own slot.
CREATE UNIQUE INDEX IF NOT EXISTS title_words_topic_slot
  ON title_words (category, subcategory, tier) WHERE subcategory IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS title_words_subject_slot
  ON title_words (category, tier) WHERE subcategory IS NULL;

ALTER TABLE title_words ENABLE ROW LEVEL SECURITY;


-- --------------------------------------------
-- READ IS OPEN. Every player's gallery needs it, guests included — seeing what
-- an account is for is the whole point of letting them look.
--
-- WRITE IS ADMINS ONLY, and the predicate is `profiles.user_id`, NEVER
-- `profiles.id`. `profiles` has both, and it is user_id that holds the auth
-- user's id — migration 024 compared the wrong one, matched no row for anybody,
-- and granted nothing while the dashboard listed it as installed.
-- tests/migration-policies.test.js fails the build on that mistake now.
-- --------------------------------------------
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'title_words'
  LOOP
    EXECUTE format('DROP POLICY %I ON title_words', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "Title words: anyone can read"
  ON title_words FOR SELECT TO public USING (true);

CREATE POLICY "Title words: admins can insert"
  ON title_words FOR INSERT TO public
  WITH CHECK (EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.is_admin = true
  ));

CREATE POLICY "Title words: admins can update"
  ON title_words FOR UPDATE TO public
  USING (EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.is_admin = true
  ));

CREATE POLICY "Title words: admins can delete"
  ON title_words FOR DELETE TO public
  USING (EXISTS (
    SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.is_admin = true
  ));

GRANT SELECT ON title_words TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON title_words TO authenticated;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
--
-- Checks that the door is open where it must be and shut where it must be,
-- rather than that a policy merely EXISTS. A policy restricted to a role nobody
-- holds exists and admits nobody, which is how `rooms` came to refuse every
-- game the day anonymous sign-ins were switched on.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'the table is there' AS thing,
    CASE WHEN to_regclass('public.title_words') IS NOT NULL THEN 'ok' ELSE 'MISSING' END AS verdict

  UNION ALL SELECT 2, 'anyone can read the words',
    CASE WHEN has_table_privilege('anon', 'public.title_words', 'SELECT')
          AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                       AND tablename='title_words' AND cmd IN ('SELECT','ALL')
                       AND roles = '{public}')
    THEN 'ok' ELSE 'FAIL nobody could see any title' END

  UNION ALL SELECT 3, 'a visitor cannot write one',
    CASE WHEN has_table_privilege('anon', 'public.title_words', 'INSERT')
    THEN 'FAIL anyone could invent a title' ELSE 'ok' END

  UNION ALL SELECT 4, 'an admin can write one',
    CASE WHEN has_table_privilege('authenticated', 'public.title_words', 'INSERT')
          AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                       AND tablename='title_words' AND cmd IN ('INSERT','ALL'))
    THEN 'ok' ELSE 'FAIL the admin page could not save a word' END

  UNION ALL SELECT 5, 'one word per slot',
    CASE WHEN (SELECT count(*) FROM pg_indexes WHERE schemaname='public'
                AND tablename='title_words'
                AND indexname IN ('title_words_topic_slot','title_words_subject_slot')) = 2
    THEN 'ok' ELSE 'FAIL the same slot could hold two words' END
) report ORDER BY ord;
