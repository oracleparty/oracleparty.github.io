-- ============================================
-- 077 — A FRIEND REQUEST ARRIVES WHILE YOU ARE ON THE PAGE
--
-- Found 2026-10-28 by 076's own check: the owner pasted its rows and
-- friend_requests read NOT LIVE. js/auth.js subscribes to it over Realtime to
-- pop up "X sent a friend request" with Accept and Decline — and Supabase only
-- sends changes for tables in the `supabase_realtime` publication, so that
-- popup has never once appeared. Requests still arrive; they are just only
-- seen on the profile's Friends tab.
--
-- Realtime applies row-level security to what it sends, so a person is told
-- only about requests they could already read.
--
-- Safe to run twice: it adds the table only if it is not already there.
-- ============================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public' AND tablename = 'friend_requests')
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_requests;
  END IF;
END $$;

-- ============================================
-- VERIFICATION — run this SELECT on its own. Every `live` should read ok.
-- ============================================
SELECT t.tablename,
       CASE WHEN p.tablename IS NOT NULL THEN 'ok' ELSE 'NOT LIVE' END AS live
  FROM (VALUES ('rooms'), ('players'), ('answers'), ('chat_messages'), ('friend_requests'), ('answer_claps')) AS t(tablename)
  LEFT JOIN pg_publication_tables p
    ON p.pubname = 'supabase_realtime' AND p.schemaname = 'public' AND p.tablename = t.tablename
 ORDER BY t.tablename;
