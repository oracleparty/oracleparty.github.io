-- ============================================
-- Oracle Party — a scratch approximation of the live tables
--
-- ONLY for scripts/verify-sql.mjs, which stands up a throwaway Postgres so
-- server-side game logic can be run and proved before anybody pastes it into
-- the Supabase editor. It is never applied to the live project and nothing
-- reads it at runtime.
--
-- THIS IS AN APPROXIMATION AND MUST BE TREATED AS ONE. `rooms`, `players` and
-- `answers` predate the migrations folder, so their real definitions are not in
-- this repo at all (CLAUDE.md #7) and the live database has been caught
-- enforcing rules no migration declares (#10). The column NAMES here come from
-- the list scripts/probe-db.mjs checks against the live database, which is
-- measured; the TYPES and defaults are inferred and some are certainly wrong in
-- detail.
--
-- So: this proves the LOGIC of a function — that it judges, scores and refuses
-- the right things. It cannot prove the function will apply cleanly live. Only
-- running the migration and reading the verification block does that.
-- ============================================

CREATE TABLE IF NOT EXISTS questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question text NOT NULL,
  correct_answer text NOT NULL,
  acceptable_answers text[] DEFAULT ARRAY[]::text[],
  incorrect_answers text[] DEFAULT ARRAY[]::text[],
  categories text[] DEFAULT ARRAY[]::text[],
  subcategory text,
  difficulty text,
  format text DEFAULT 'open',
  fun_fact text
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE,
  host_name text,
  category text,
  subcategory text,
  status text DEFAULT 'lobby',
  game_phase text DEFAULT 'lobby',
  current_question int DEFAULT 0,
  question_ids uuid[] DEFAULT ARRAY[]::uuid[],
  used_question_ids uuid[] DEFAULT ARRAY[]::uuid[],
  question_started_at timestamptz,
  countdown_started_at timestamptz,
  questions_per_game int DEFAULT 10,
  question_timer int DEFAULT 30,
  auto_proceed boolean DEFAULT false,
  who_can_join text DEFAULT 'anyone',
  room_scores jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  display_name text,
  is_host boolean DEFAULT false,
  is_cohost boolean DEFAULT false,
  is_bot boolean DEFAULT false,
  is_ready boolean DEFAULT false,
  score int DEFAULT 0,
  user_id uuid,
  avatar_color text,
  avatar_emoji text,
  title text,
  joined_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  disconnected_at timestamptz
);

CREATE TABLE IF NOT EXISTS answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  player_id uuid REFERENCES players(id) ON DELETE CASCADE,
  question_number int NOT NULL,
  question_id uuid,
  wager int,
  submitted_answer text DEFAULT '',
  is_correct boolean DEFAULT false,
  auto_correct boolean DEFAULT false,
  score_earned int DEFAULT 0,
  history_recorded boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- The upsert conflict target the app relies on. Measured as present live
-- (CLAUDE.md #2) — a missing one raises 42P10 and kills every write through
-- that path.
CREATE UNIQUE INDEX IF NOT EXISTS answers_room_player_question
  ON answers (room_id, player_id, question_number);
