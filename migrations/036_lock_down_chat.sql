-- ============================================
-- Migration 036 — take away chat permissions nothing uses
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHAT THIS DOES
--
-- Every gameplay table in this project was made permissive in one sweep
-- (migration 022): USING (true) / WITH CHECK (true) for everything. That was
-- the right call at the time — with judging and scoring running in players'
-- browsers, clients genuinely need to write. But it handed out rights the app
-- has never used, and an unused right is pure downside.
--
-- Checked against js/ before writing this, not assumed:
--
--   chat_messages — INSERT (send), SELECT (read), UPDATE (hearts). Never
--                   deleted. Messages disappear when their room is deleted,
--                   which happens by cascade as the table owner and is not
--                   affected by these policies.
--   chat_archive  — INSERT and SELECT only. Never updated, never deleted.
--
-- So today any visitor holding the publishable key — which is in the page
-- source of every page, by necessity — could delete every chat message and
-- every archive in the game. Nobody needs that, so nobody gets it.
--
-- WHAT THIS DOES NOT DO, AND IT IS THE BIGGER HALF
--
-- It does not stop someone READING a room's chat they were never in. That
-- cannot be fixed with permissions alone, because permissions decide by
-- identity and a guest has none — they are all the same anonymous key. The
-- only real fixes are to require sign-in, which would end guest play, or to
-- put a server between players and the database so each one can be issued a
-- token. That second one is the server-authority rebuild already recorded as
-- the main open work item (CLAUDE.md #1), and chat privacy comes with it.
--
-- Until then the privacy policy says plainly that chat should be treated as
-- public. That is the honest position, and it is better than a lock that
-- looks like one and is not.
-- ============================================

-- --- chat_messages: no deleting ---------------------------------------

DROP POLICY IF EXISTS "Chat messages: anyone can delete" ON chat_messages;
DROP POLICY IF EXISTS "Anyone can delete chat messages" ON chat_messages;
DROP POLICY IF EXISTS "Chat: anyone can delete" ON chat_messages;

-- A FOR ALL policy grants delete as a side effect, so any that exist are
-- replaced by the three the app actually needs.
DROP POLICY IF EXISTS "Chat messages: anyone" ON chat_messages;
DROP POLICY IF EXISTS "Anyone can do anything with chat messages" ON chat_messages;

DROP POLICY IF EXISTS "Chat messages: read" ON chat_messages;
CREATE POLICY "Chat messages: read"
  ON chat_messages FOR SELECT USING (true);

DROP POLICY IF EXISTS "Chat messages: send" ON chat_messages;
CREATE POLICY "Chat messages: send"
  ON chat_messages FOR INSERT WITH CHECK (true);

-- Hearts are the only thing that changes on an existing message.
DROP POLICY IF EXISTS "Chat messages: hearts" ON chat_messages;
CREATE POLICY "Chat messages: hearts"
  ON chat_messages FOR UPDATE USING (true) WITH CHECK (true);


-- --- chat_archive: write once, read, nothing else ---------------------

DROP POLICY IF EXISTS "Chat archive: anyone can delete" ON chat_archive;
DROP POLICY IF EXISTS "Anyone can delete chat archive" ON chat_archive;
DROP POLICY IF EXISTS "Chat archive: anyone" ON chat_archive;
DROP POLICY IF EXISTS "Anyone can do anything with chat archive" ON chat_archive;

DROP POLICY IF EXISTS "Chat archive: read" ON chat_archive;
CREATE POLICY "Chat archive: read"
  ON chat_archive FOR SELECT USING (true);

DROP POLICY IF EXISTS "Chat archive: write" ON chat_archive;
CREATE POLICY "Chat archive: write"
  ON chat_archive FOR INSERT WITH CHECK (true);


-- --------------------------------------------
-- VERIFY — should list only the policies above, and NO row whose cmd is
-- DELETE or ALL. If you see DELETE or ALL, a policy exists under a name this
-- migration did not guess; send the output back rather than editing blind.
-- --------------------------------------------

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE tablename IN ('chat_messages', 'chat_archive')
 ORDER BY tablename, cmd, policyname;
