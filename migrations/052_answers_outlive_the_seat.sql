-- ============================================
-- 052 — A PLAYER'S ANSWERS OUTLIVE THE SEAT THEY WERE GIVEN IN
--
-- MEASURED, not inferred. The CI probe reported on 2026-08-25:
--
--     --- CAN A REJOINING PLAYER RECOVER THEIR ANSWERS? ---
--       answers -> players: RELATED
--       answers -> rooms:   RELATED
--
-- PostgREST resolves an embedded `answers?select=id,players(id)` only when a
-- foreign key exists between the two tables, so that is a fact about the live
-- database rather than a guess from `migrations/` (CLAUDE.md #7, #10).
--
-- WHAT IT MEANS. Embedding proves the key EXISTS; it cannot see the ON DELETE
-- action, and this migration does not need to guess, because **all three
-- possibilities are broken and all three are fixed by dropping it**:
--
--   CASCADE   the answers are deleted with the seat. Nothing to reassign, so
--             "rejoining restores your score" silently does nothing.
--   SET NULL  the rows survive with player_id nulled. Same outcome — the id
--             reassignPlayerAnswers looks them up by is gone.
--   NO ACTION / RESTRICT
--             deleting the player RAISES 23503 instead, so removePlayer fails
--             for anybody who has answered a round. That failure is logged and
--             never shown, and it would leave exactly the ghost rows this
--             project has been chasing: a seat that cannot be swept, for every
--             player who actually played.
--
-- **This block records which one it was.** It captures confdeltype before
-- dropping, so the answer ends up in the migration's own output rather than
-- being inferred from behaviour afterwards. Say where a number came from, or
-- do not write it down.
--
-- THE PROMISE THIS BREAKS. CLAUDE.md has said for months:
--
--     "STALE_TIMEOUT_MS — the seat is released. Rejoining reassigns previous
--      answers to the new player row, so score and history survive."
--
-- reassignPlayerAnswers finds those rows BY THE OLD player_id. There are none.
-- A player whose phone dies for two minutes mid-game has always come back to
-- nothing, and nothing said so: the reassignment reports success having moved
-- zero rows, which is indistinguishable from having had nothing to move.
--
-- THE FIX IS THE ONE MIGRATION 033 ALREADY MADE for `game_plays`, and for the
-- same reason. An answer is a record that a round was played — by someone, in
-- a room, at a time. The seat is how that person was reached while the game was
-- running, not what the record is ABOUT. A key that has to be cascaded or
-- nulled every time somebody's phone locks is not describing a real
-- relationship; it is describing a lifetime that does not belong to it.
--
-- `answers.room_id` KEEPS ITS KEY, deliberately. Answers really are scratch
-- data for one room: when the room goes they should go with it, which is also
-- what stops orphans accumulating forever now that the player key is gone.
-- That is unchanged and 033 made the same distinction.
--
-- Dropped BY LOOKING rather than by name. The live constraint names in this
-- project are not the ones the migrations declare — that is exactly why 049's
-- by-name DROP POLICY did nothing and reported nothing (CLAUDE.md).
-- ============================================

CREATE TEMP TABLE op052_dropped (conname text, on_delete text);

DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT c.conname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class     src ON src.oid = c.conrelid
      JOIN pg_class     tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace n   ON n.oid   = src.relnamespace
     WHERE c.contype = 'f'
       AND n.nspname = 'public'
       AND src.relname = 'answers'
       AND tgt.relname = 'players'
  LOOP
    -- Recorded BEFORE the drop. Once it is gone, nothing can say what it did,
    -- and which of the three it was decides how the bug presented to players:
    -- CASCADE and SET NULL lose the answers, NO ACTION loses the player row.
    INSERT INTO op052_dropped VALUES (con.conname,
      CASE con.confdeltype WHEN 'c' THEN 'CASCADE — answers were DELETED with the seat'
                           WHEN 'n' THEN 'SET NULL — answers survived but forgot whose they were'
                           WHEN 'd' THEN 'SET DEFAULT'
                           WHEN 'r' THEN 'RESTRICT — removing a player who had answered FAILED (23503)'
                           ELSE 'NO ACTION — removing a player who had answered FAILED (23503)' END);
    EXECUTE format('ALTER TABLE public.answers DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;


-- --------------------------------------------
-- VERIFY
--
-- One result set, and it prints the evidence either way — a check that can
-- fail should say what it saw, which is the lesson 051 learned the hard way.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'rejoin_keeps_score' AS check_name,
         CASE WHEN NOT EXISTS (
                SELECT 1 FROM pg_constraint c
                  JOIN pg_class src ON src.oid = c.conrelid
                  JOIN pg_class tgt ON tgt.oid = c.confrelid
                  JOIN pg_namespace n ON n.oid = src.relnamespace
                 WHERE c.contype='f' AND n.nspname='public'
                   AND src.relname='answers' AND tgt.relname='players')
              THEN 'ok'
              ELSE 'FAIL a released seat still takes its answers with it' END AS result
  UNION ALL
  SELECT 2, 'answers_still_die_with_the_room',
         CASE WHEN EXISTS (
                SELECT 1 FROM pg_constraint c
                  JOIN pg_class src ON src.oid = c.conrelid
                  JOIN pg_class tgt ON tgt.oid = c.confrelid
                  JOIN pg_namespace n ON n.oid = src.relnamespace
                 WHERE c.contype='f' AND n.nspname='public'
                   AND src.relname='answers' AND tgt.relname='rooms')
              THEN 'ok'
              ELSE 'FAIL answers would now outlive their room and never be cleaned up' END
  UNION ALL
  -- What was actually removed, and what it had been doing. This is the only
  -- moment the answer is knowable.
  SELECT 3, 'was: ' || conname, on_delete FROM op052_dropped
  UNION ALL
  SELECT 3, 'was: (nothing)', 'no key from answers to players — already fixed'
   WHERE NOT EXISTS (SELECT 1 FROM op052_dropped)
  UNION ALL
  -- Every foreign key left on `answers`, with what it does on delete, so the
  -- verdicts above come with the thing they were read from.
  SELECT 4, 'answers.' || (
           SELECT string_agg(a.attname, ',') FROM unnest(c.conkey) k(attnum)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
         tgt.relname || '  ON DELETE ' ||
         CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT'
                            ELSE 'NO ACTION' END
    FROM pg_constraint c
    JOIN pg_class     src ON src.oid = c.conrelid
    JOIN pg_class     tgt ON tgt.oid = c.confrelid
    JOIN pg_namespace n   ON n.oid   = src.relnamespace
   WHERE c.contype='f' AND n.nspname='public' AND src.relname='answers'
) report ORDER BY ord, check_name;
