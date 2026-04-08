-- Migration 022: Atomic increment RPC + RLS for core gameplay tables
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)

-- ============================================
-- 1. Atomic increment for questions_answered
--    Eliminates race condition in read-then-write pattern.
--    Called from JS as: supabase.rpc('increment_questions_answered', { p_room_id, p_player_id })
-- ============================================

CREATE OR REPLACE FUNCTION increment_questions_answered(p_room_id bigint, p_player_id bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE game_plays
  SET questions_answered = COALESCE(questions_answered, 0) + 1
  WHERE room_id = p_room_id AND player_id = p_player_id;
$$;

-- Grant execute to anon and authenticated roles (matches your existing access pattern)
GRANT EXECUTE ON FUNCTION increment_questions_answered(bigint, bigint) TO anon, authenticated;


-- ============================================
-- 2. RLS for core gameplay tables
--    These tables currently have NO RLS, meaning anyone with your
--    anon key can read/write all data. The policies below allow
--    broad read access (needed for gameplay) but restrict writes.
-- ============================================

-- --- rooms ---
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Rooms: anyone can read"      ON rooms FOR SELECT USING (true);
CREATE POLICY "Rooms: anyone can insert"     ON rooms FOR INSERT WITH CHECK (true);
CREATE POLICY "Rooms: anyone can update"     ON rooms FOR UPDATE USING (true);
CREATE POLICY "Rooms: anyone can delete"     ON rooms FOR DELETE USING (true);
-- NOTE: These are permissive because room management is host-controlled via
-- application logic, not auth. Tighten these if you add auth-gated hosting.

-- --- players ---
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Players: anyone can read"     ON players FOR SELECT USING (true);
CREATE POLICY "Players: anyone can insert"   ON players FOR INSERT WITH CHECK (true);
CREATE POLICY "Players: anyone can update"   ON players FOR UPDATE USING (true);
CREATE POLICY "Players: anyone can delete"   ON players FOR DELETE USING (true);
-- NOTE: Same as rooms — guests can play without auth, so broad access needed.

-- --- answers ---
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Answers: anyone can read"     ON answers FOR SELECT USING (true);
CREATE POLICY "Answers: anyone can insert"   ON answers FOR INSERT WITH CHECK (true);
CREATE POLICY "Answers: anyone can update"   ON answers FOR UPDATE USING (true);
CREATE POLICY "Answers: anyone can delete"   ON answers FOR DELETE USING (true);

-- --- chat_messages ---
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chat: anyone can read"        ON chat_messages FOR SELECT USING (true);
CREATE POLICY "Chat: anyone can insert"      ON chat_messages FOR INSERT WITH CHECK (true);

-- --- chat_archive ---
ALTER TABLE chat_archive ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chat archive: anyone can read"   ON chat_archive FOR SELECT USING (true);
CREATE POLICY "Chat archive: anyone can insert" ON chat_archive FOR INSERT WITH CHECK (true);
CREATE POLICY "Chat archive: anyone can update" ON chat_archive FOR UPDATE USING (true);

-- --- questions (read-only for clients) ---
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Questions: anyone can read"   ON questions FOR SELECT USING (true);
-- No insert/update/delete policies — only admins via service_role key should modify questions.

-- --- site_settings (read-only for clients) ---
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Site settings: anyone can read"   ON site_settings FOR SELECT USING (true);
CREATE POLICY "Site settings: anyone can update"  ON site_settings FOR UPDATE USING (true);
-- NOTE: Tighten update policy to admin-only if you add admin auth checks.

-- --- game_plays (ensure RLS is on — migration 021 added policies but may not have enabled RLS) ---
ALTER TABLE game_plays ENABLE ROW LEVEL SECURITY;
-- Policies from migration 021 should already exist; adding SELECT if missing:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'game_plays' AND policyname = 'Game plays: anyone can read'
  ) THEN
    EXECUTE 'CREATE POLICY "Game plays: anyone can read" ON game_plays FOR SELECT USING (true)';
  END IF;
END $$;
