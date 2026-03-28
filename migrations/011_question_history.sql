-- Migration: Create question_history table for smart question selection
-- Tracks which questions each player has seen and whether they answered correctly.
-- Used by the smart selection algorithm: fresh-first, redemption chance, mastered-last.

CREATE TABLE IF NOT EXISTS question_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id UUID NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  times_correct INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_question_history_user ON question_history(user_id);

ALTER TABLE question_history ENABLE ROW LEVEL SECURITY;

-- Public read: the host needs to read all room players' history for smart selection
CREATE POLICY "Question history: public read"
  ON question_history FOR SELECT USING (true);

CREATE POLICY "Question history: user insert own"
  ON question_history FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Question history: user update own"
  ON question_history FOR UPDATE USING (user_id = auth.uid());
