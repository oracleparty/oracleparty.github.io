-- ============================================
-- 064 — A PLACEHOLDER IS A REAL WORD THAT SAYS IT IS TEMPORARY
--
-- The owner's call, and it reverses a rule they set themselves. That rule was
-- "no placeholder words, ever", and its reasoning was sound: a player must never
-- hit a requirement and receive NOTHING, so a slot with no word simply did not
-- exist for them. The consequence was that eleven of twelve subjects showed
-- almost nothing, and the framework — which is complete in code — was invisible.
--
-- A PLACEHOLDER IS NOT NOTHING. "Epic Science" is a real word that a player
-- really earns, so the original objection does not apply to it. What it does is
-- make every slot visible and earnable now, and leave the owner free to replace
-- the text later without anybody losing what they earned.
--
-- THE UNLOCK SURVIVES THE RENAME, and that is what makes this safe. A word's id
-- is `w:<category>:<subcategory>:<tier>` — it does not contain the text — so
-- editing "Epic Science" into something better keeps it in the collection of
-- everybody who already has it. That is asserted by tests/titles.test.js
-- ("keeps the same id when the word is rewritten") and was built before this.
--
-- THE FLAG IS EXPLICIT, NOT INFERRED. The obvious cheap alternative is to call
-- a word a placeholder when its text matches what the generator would produce.
-- That needs no column and un-flags itself on edit, which is neat — and it is
-- exactly the kind of inference this project has been bitten by: change the
-- naming rule once and every existing placeholder silently becomes "written".
-- One boolean, and the admin page can be trusted about which is which.
-- ============================================

ALTER TABLE title_words
  ADD COLUMN IF NOT EXISTS is_placeholder boolean NOT NULL DEFAULT false;

-- The admin page counts written words separately from placeholders, and that
-- count is the owner's whole view of how much is left to do.
CREATE INDEX IF NOT EXISTS title_words_placeholder
  ON title_words (is_placeholder) WHERE is_placeholder = true;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'the flag exists' AS thing,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'title_words'
         AND column_name = 'is_placeholder'
    ) THEN 'ok' ELSE 'MISSING' END AS verdict

  UNION ALL SELECT 2, 'existing words are not marked as placeholders',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM title_words WHERE is_placeholder = true
    ) OR (SELECT count(*) FROM title_words) = 0
    THEN 'ok' ELSE 'CHECK a word you wrote is flagged temporary' END

  UNION ALL SELECT 3, 'a visitor still cannot write one',
    CASE WHEN has_table_privilege('anon', 'public.title_words', 'INSERT')
    THEN 'FAIL anyone could invent a title' ELSE 'ok' END

  UNION ALL SELECT 4, 'players can still read them',
    CASE WHEN has_table_privilege('anon', 'public.title_words', 'SELECT')
    THEN 'ok' ELSE 'FAIL nobody could see any title' END
) report ORDER BY ord;
