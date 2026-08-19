-- ============================================
-- Why do the categories show 0 plays?
--
-- READ-ONLY. This changes nothing — every line is a SELECT. Paste the whole
-- thing into the Supabase SQL Editor, press Run, and send back the table it
-- prints. It returns one small table with a label beside each answer.
--
-- WHY THIS HAS TO BE RUN BY HAND
--
-- The automated probe sees the database as an ordinary visitor, and a visitor
-- cannot tell "this table is empty" from "this table has rows I am not allowed
-- to see" — a row-level policy filters rows out rather than refusing the
-- request. It also cannot read foreign keys: it tried, and reported that it
-- could not, which is the honest answer rather than a guess.
--
-- The SQL Editor runs as the database owner, so it can see all of it.
--
-- WHAT EACH LINE IS FOR
--
--   game_plays rows        — if this is 0, nothing is being recorded, or
--                            something is deleting it afterwards.
--   marked completed       — a row is written when a game STARTS and marked
--                            complete at the results screen. Rows that exist
--                            but are never completed would point at the
--                            results screen, not the recording.
--   rooms in the table     — rooms are deleted when the last player leaves.
--   the function's output  — what the category cards actually receive. If this
--                            has rows but the cards show 0, the bug is in the
--                            app, not the data.
--   foreign keys           — THE MAIN SUSPECT. If game_plays points at rooms
--                            with ON DELETE CASCADE, then every play record is
--                            destroyed the moment the room is cleaned up at the
--                            end of a session. That would look exactly like
--                            "it stopped counting" while nothing was ever
--                            wrong with the counting. `answers` is listed
--                            beside it because it is already known to be
--                            deleted with the room, so it shows what a
--                            cascading key looks like here.
--   filters on completed   — there are two versions of this function in the
--                            repo's history, one of which only counts finished
--                            games. This says which one is installed.
--   question_feedback rows — unrelated, and settles a separate open question:
--                            the probe reads that table as empty, and nobody
--                            has established whether it is empty or hidden.
-- ============================================

SELECT 'game_plays rows (total)' AS what,
       count(*)::text AS answer
  FROM game_plays

UNION ALL
SELECT 'game_plays rows marked completed',
       count(*)::text
  FROM game_plays
 WHERE completed IS TRUE

UNION ALL
SELECT 'rooms currently in the table',
       count(*)::text
  FROM rooms

UNION ALL
SELECT 'what get_category_play_counts() returns',
       coalesce(
         string_agg(category || coalesce('/' || subcategory, '') || '=' || play_count, ', '
                    ORDER BY category),
         '(nothing at all)')
  FROM get_category_play_counts()

UNION ALL
SELECT 'foreign keys on game_plays',
       coalesce(
         string_agg(tc.constraint_name || ' -> ' || ccu.table_name ||
                    ' ON DELETE ' || rc.delete_rule, ', '),
         '(none)')
  FROM information_schema.table_constraints tc
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
   AND rc.constraint_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.table_schema
 WHERE tc.table_name = 'game_plays'
   AND tc.constraint_type = 'FOREIGN KEY'

UNION ALL
SELECT 'foreign keys on answers (a known cascading one, for comparison)',
       coalesce(
         string_agg(tc.constraint_name || ' -> ' || ccu.table_name ||
                    ' ON DELETE ' || rc.delete_rule, ', '),
         '(none)')
  FROM information_schema.table_constraints tc
  JOIN information_schema.referential_constraints rc
    ON rc.constraint_name = tc.constraint_name
   AND rc.constraint_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.table_schema
 WHERE tc.table_name = 'answers'
   AND tc.constraint_type = 'FOREIGN KEY'

UNION ALL
SELECT 'does get_category_play_counts only count finished games?',
       coalesce(
         (SELECT CASE WHEN pg_get_functiondef(p.oid) ILIKE '%completed%'
                      THEN 'yes — it filters on completed'
                      ELSE 'no — it counts every row' END
            FROM pg_proc p
           WHERE p.proname = 'get_category_play_counts'
           LIMIT 1),
         '(the function is not installed)')

UNION ALL
SELECT 'question_feedback rows (separate question)',
       count(*)::text
  FROM question_feedback;
