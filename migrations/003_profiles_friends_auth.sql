-- Migration 003: Profiles, Friends, Auth, Game History
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

-- =============================================
-- 1. PROFILES
-- =============================================
CREATE TABLE profiles (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name     TEXT NOT NULL,
  discriminator    TEXT NOT NULL,
  avatar_color     TEXT DEFAULT '#C68A2E',
  avatar_emoji     TEXT DEFAULT '🏛️',
  bio              TEXT DEFAULT '',
  favorite_category TEXT,
  visibility       TEXT NOT NULL DEFAULT 'public'
                     CHECK (visibility IN ('public', 'friends', 'private')),
  show_online_status BOOLEAN NOT NULL DEFAULT true,
  honks_received   INTEGER NOT NULL DEFAULT 0,
  honks_given      INTEGER NOT NULL DEFAULT 0,
  questions_flagged INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,

  UNIQUE(display_name, discriminator)
);

CREATE INDEX idx_profiles_display_name ON profiles (display_name);
CREATE INDEX idx_profiles_discriminator ON profiles (display_name, discriminator);

-- =============================================
-- 2. PLAYER_STATS
-- =============================================
CREATE TABLE player_stats (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category          TEXT NOT NULL,
  questions_answered INTEGER NOT NULL DEFAULT 0,
  correct_answers   INTEGER NOT NULL DEFAULT 0,
  games_played      INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,

  UNIQUE(user_id, category)
);

CREATE INDEX idx_player_stats_user_id ON player_stats (user_id);

-- =============================================
-- 3. FRIEND_REQUESTS
-- =============================================
CREATE TABLE friend_requests (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(sender_id, receiver_id),
  CHECK (sender_id != receiver_id)
);

CREATE INDEX idx_friend_requests_receiver ON friend_requests (receiver_id, status);
CREATE INDEX idx_friend_requests_sender ON friend_requests (sender_id, status);

-- =============================================
-- 4. FRIENDSHIPS
-- =============================================
CREATE TABLE friendships (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_a     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_b     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source     TEXT DEFAULT 'request',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX idx_friendships_user_a ON friendships (user_a);
CREATE INDEX idx_friendships_user_b ON friendships (user_b);

-- =============================================
-- 5. GAME_HISTORY
-- =============================================
CREATE TABLE game_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  room_id       UUID,
  category      TEXT NOT NULL,
  score         INTEGER NOT NULL DEFAULT 0,
  placement     INTEGER NOT NULL,
  total_players INTEGER NOT NULL,
  played_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_game_history_user_id ON game_history (user_id);
CREATE INDEX idx_game_history_played_at ON game_history (user_id, played_at DESC);

-- =============================================
-- 6. ALTER PLAYERS TABLE
-- =============================================
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_spectator BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_players_user_id ON players (user_id) WHERE user_id IS NOT NULL;

-- =============================================
-- 7. RLS POLICIES (new tables only)
-- =============================================

-- PROFILES
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles: public read"
  ON profiles FOR SELECT
  USING (visibility = 'public' OR user_id = auth.uid());

CREATE POLICY "Profiles: owner insert"
  ON profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Profiles: owner update"
  ON profiles FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Profiles: anon read public"
  ON profiles FOR SELECT TO anon
  USING (visibility = 'public');

-- PLAYER_STATS
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Stats: public read"
  ON player_stats FOR SELECT
  USING (true);

CREATE POLICY "Stats: owner insert"
  ON player_stats FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Stats: owner update"
  ON player_stats FOR UPDATE
  USING (user_id = auth.uid());

-- FRIEND_REQUESTS
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Friend requests: participant read"
  ON friend_requests FOR SELECT
  USING (sender_id = auth.uid() OR receiver_id = auth.uid());

CREATE POLICY "Friend requests: sender insert"
  ON friend_requests FOR INSERT
  WITH CHECK (sender_id = auth.uid());

CREATE POLICY "Friend requests: receiver update"
  ON friend_requests FOR UPDATE
  USING (receiver_id = auth.uid());

-- FRIENDSHIPS
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Friendships: participant read"
  ON friendships FOR SELECT
  USING (user_a = auth.uid() OR user_b = auth.uid());

CREATE POLICY "Friendships: participant insert"
  ON friendships FOR INSERT
  WITH CHECK (user_a = auth.uid() OR user_b = auth.uid());

CREATE POLICY "Friendships: participant delete"
  ON friendships FOR DELETE
  USING (user_a = auth.uid() OR user_b = auth.uid());

-- GAME_HISTORY
ALTER TABLE game_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Game history: public read"
  ON game_history FOR SELECT
  USING (true);

CREATE POLICY "Game history: owner insert"
  ON game_history FOR INSERT
  WITH CHECK (user_id = auth.uid());
