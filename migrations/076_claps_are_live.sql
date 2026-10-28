-- ============================================
-- 076 — CLAPS ARRIVE LIVE
--
-- Reported 2026-10-28: "Still can't see the clap from my friend or vice versa
-- on answers we like." Migration 071 created answer_claps and the client
-- subscribes to it over Realtime — but Supabase only sends changes for tables
-- in the `supabase_realtime` publication, and 071 never added it. No migration
-- in this repo has ever touched the publication: rooms, players and answers
-- were added in the dashboard long ago, by hand, so a new table is silent by
-- default and nothing says so.
--
-- The client now re-reads claps every 3 seconds on the reveal, so claps work
-- with or without this. This makes them instant. It is also not the whole
-- story for a WITHDRAWN clap: Realtime does not deliver a DELETE through a
-- room_id filter, so taking a clap back always travels by the re-read.
--
-- Safe to run twice: it adds the table only if it is not already there.
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'answer_claps')
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.answer_claps;
  END IF;
END $$;

-- ============================================
-- VERIFICATION — run this SELECT on its own. One row per table the game
-- listens to; every `live` should read ok. answer_claps is the one this
-- migration adds; the others are listed so a missing one is visible too.
-- ============================================
SELECT t.tablename,
       CASE WHEN p.tablename IS NOT NULL THEN 'ok' ELSE 'NOT LIVE' END AS live
  FROM (VALUES ('rooms'), ('players'), ('answers'), ('chat_messages'), ('friend_requests'), ('answer_claps')) AS t(tablename)
  LEFT JOIN pg_publication_tables p
    ON p.pubname = 'supabase_realtime' AND p.schemaname = 'public' AND p.tablename = t.tablename
 ORDER BY t.tablename;
